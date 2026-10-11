#!/usr/bin/env python3
"""Dependency-light HTTPS annotation service for the DRST-Bench v1 pilot."""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import mimetypes
import os
import secrets
import sqlite3
import ssl
import time
from contextlib import closing
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
STATIC = HERE / "static"
DEFAULT_DATA = ROOT / "dataset" / "DRST_bench_v1" / "natural" / "trajectories.jsonl"
DEFAULT_EVENTS = ROOT / "dataset" / "DRST_bench_v1" / "probes" / "review_v3" / "strict_events.jsonl"
DEFAULT_STATE = ROOT / "dataset" / "DRST_bench_v1" / "annotations"

LABELS = {
    "belief": ["unknown", "reject", "uncertain", "accept"],
    "trust": ["unknown", "distrust", "uncertain", "trust"],
    "commitment": ["unknown", "none", "considering", "conditional", "committed", "withdrawn"],
    "emotion": ["neutral", "joy", "anger", "sadness", "fear", "disgust", "surprise", "mixed", "unknown"],
}
VISIBILITY = {"direct", "reported", "inferred", "hidden"}
EFFECTIVE_AT = {"pre_response", "post_response"}
DECISIONS = {"changes", "no_change", "unlabelable"}
REVIEW_DECISIONS = {"accept", "edit", "ambiguous", "exclude"}
REVIEW_REASONS = {
    "insufficient_prior", "insufficient_after", "no_transition", "object_unclear",
    "low_benchmark_value", "future_context", "duplicate", "out_of_scope", "other",
}
REVIEW_SCHEMA = "strict_event_review_v2"
LIMITS = {"belief": 3, "trust": 2, "commitment": 2, "emotion": 1}


def b64e(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64d(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def json_bytes(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def password_hash(password: str, salt_hex: str, iterations: int = 310_000) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), iterations).hex()


class AnnotationStore:
    def __init__(self, data_path: Path, db_path: Path, events_path: Path = DEFAULT_EVENTS, only_with_events: bool = False):
        all_trajectories = [json.loads(line) for line in data_path.read_text(encoding="utf-8").splitlines() if line.strip()]
        all_by_id = {row["trajectory_id"]: row for row in all_trajectories}
        events = [json.loads(line) for line in events_path.read_text(encoding="utf-8").splitlines() if line.strip()]
        self.events_by_trajectory = {trajectory_id: [] for trajectory_id in all_by_id}
        for event in events:
            if event.get("trajectory_id") in self.events_by_trajectory:
                self.events_by_trajectory[event["trajectory_id"]].append(event)
        for values in self.events_by_trajectory.values():
            values.sort(key=lambda event: (
                int(event.get("round_id", 0)),
                0 if event.get("effective_at") == "pre_response" else 1,
                str(event.get("dimension", "")), str(event.get("object", "")), str(event.get("event_id", "")),
            ))
        self.trajectories = [
            row for row in all_trajectories
            if not only_with_events or self.events_by_trajectory.get(row["trajectory_id"])
        ]
        self.by_id = {row["trajectory_id"]: row for row in self.trajectories}
        self.events_by_trajectory = {
            trajectory_id: self.events_by_trajectory[trajectory_id] for trajectory_id in self.by_id
        }
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.db_path = db_path
        with closing(self.connect()) as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                PRAGMA foreign_keys=ON;
                CREATE TABLE IF NOT EXISTS annotations (
                    username TEXT NOT NULL,
                    trajectory_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    payload TEXT NOT NULL,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    submitted_at TEXT,
                    PRIMARY KEY (username, trajectory_id)
                );
                CREATE TABLE IF NOT EXISTS audit_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL,
                    trajectory_id TEXT NOT NULL,
                    action TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    payload_sha256 TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
            """)

    def connect(self):
        return sqlite3.connect(self.db_path, timeout=20)

    def list_tasks(self, username: str) -> list[dict]:
        with closing(self.connect()) as db:
            saved = {row[0]: (row[1], row[2], row[3]) for row in db.execute(
                "SELECT trajectory_id,status,revision,updated_at FROM annotations WHERE username=?", (username,)
            )}
        result = []
        for index, traj in enumerate(self.trajectories, 1):
            state = saved.get(traj["trajectory_id"], ("unstarted", 0, None))
            result.append({
                "index": index, "trajectory_id": traj["trajectory_id"],
                "source": traj["source"].get("dataset", "unknown"),
                "target_character": traj["target_character"], "round_count": len(traj["rounds"]),
                "model_event_count": len(self.events_by_trajectory.get(traj["trajectory_id"], [])),
                "status": state[0], "revision": state[1], "updated_at": state[2],
            })
        return result

    def get_task(self, username: str, trajectory_id: str) -> dict | None:
        traj = self.by_id.get(trajectory_id)
        if traj is None:
            return None
        with closing(self.connect()) as db:
            row = db.execute(
                "SELECT status,revision,payload,updated_at,submitted_at FROM annotations WHERE username=? AND trajectory_id=?",
                (username, trajectory_id),
            ).fetchone()
        annotation = None
        if row:
            annotation = {"status": row[0], "revision": row[1], "payload": json.loads(row[2]), "updated_at": row[3], "submitted_at": row[4]}
        public = {key: value for key, value in traj.items() if key not in {"model_suggestion", "state_updates", "events"}}
        public["rounds"] = [
            {key: value for key, value in round_.items() if key not in {"events", "state_updates", "gold_pre_response_state"}}
            for round_ in traj["rounds"]
        ]
        model_annotations = []
        for event in self.events_by_trajectory.get(trajectory_id, []):
            model_annotations.append({
                "event_id": event["event_id"], "round_id": event["round_id"],
                "dimension": event["dimension"], "object": event["object"],
                "prior": event["prior"], "after": event["after"],
                "effective_at": event["effective_at"], "evidence": list(event.get("evidence", [])),
                "prior_evidence": list(event.get("prior_evidence", [])),
                "after_evidence": list(event.get("after_evidence", [])),
                "prior_quote": event.get("prior_quote", ""), "after_quote": event.get("after_quote", ""),
                "visibility": event["visibility"],
                "evaluation_question": event.get("evaluation_question", ""),
                "rationale": event.get("rationale", ""),
                "benchmark_value": event.get("benchmark_value", "core"),
                "screening_tier": event.get("screening_tier", "legacy_candidate"),
                "critic_model": event.get("critic_model", ""),
                "critic_assessment": event.get("critic_assessment", {}),
                "annotation_status": event.get("annotation_status", "model_assisted_provisional"),
                "label_source": event.get("designer", "Qwen3.6-27B"),
            })
        return {"trajectory": public, "annotation": annotation, "codebook": LABELS,
                "model_annotations": model_annotations, "review_schema": REVIEW_SCHEMA}

    def validate(self, trajectory_id: str, payload: dict, submit: bool = True) -> list[str]:
        if payload.get("review_schema") == REVIEW_SCHEMA:
            return self.validate_review(trajectory_id, payload, submit)
        traj = self.by_id[trajectory_id]
        errors = []
        decision = payload.get("decision")
        events = payload.get("events", [])
        if decision not in DECISIONS:
            errors.append("decision 必须为 changes、no_change 或 unlabelable")
        if not isinstance(events, list):
            return errors + ["events 必须是数组"]
        if decision == "changes" and not events:
            errors.append("选择 changes 时至少需要一个 delta")
        if decision in {"no_change", "unlabelable"} and events:
            errors.append(f"选择 {decision} 时不能提交 delta")
        if decision == "unlabelable" and not str(payload.get("notes", "")).strip():
            errors.append("unlabelable 必须填写原因")
        rounds = {r["round_id"]: r for r in traj["rounds"]}
        item_pos = {}
        for r in traj["rounds"]:
            item_pos[r["incoming"]["item_id"]] = (r["round_id"], 0)
            item_pos[r["target_response"]["item_id"]] = (r["round_id"], 1)
        objects = {d: set() for d in LABELS}
        for idx, event in enumerate(events, 1):
            prefix = f"delta {idx}: "
            dim = event.get("dimension")
            if dim not in LABELS:
                errors.append(prefix + "dimension 非法")
                continue
            obj = str(event.get("object", "")).strip()
            if not obj:
                errors.append(prefix + "object 不能为空")
            objects[dim].add(obj)
            if dim == "emotion" and obj != "self":
                errors.append(prefix + "emotion 的 object 必须为 self")
            if event.get("prior") not in LABELS[dim] or event.get("after") not in LABELS[dim]:
                errors.append(prefix + "prior/after 不属于该维度 Codebook")
            if event.get("prior") == event.get("after"):
                errors.append(prefix + "delta 的 prior 与 after 不能相同")
            round_id = event.get("round_id")
            if round_id not in rounds:
                errors.append(prefix + "round_id 非法")
                continue
            effective = event.get("effective_at")
            if effective not in EFFECTIVE_AT:
                errors.append(prefix + "effective_at 非法")
            visibility = event.get("visibility")
            if visibility not in VISIBILITY:
                errors.append(prefix + "visibility 非法")
            evidence = event.get("evidence", [])
            if not isinstance(evidence, list) or not evidence:
                errors.append(prefix + "至少选择一个可观察 evidence item")
            else:
                boundary = (round_id, 0 if effective == "pre_response" else 1)
                for item_id in evidence:
                    if item_id not in item_pos:
                        errors.append(prefix + f"未知 evidence item: {item_id}")
                    elif item_pos[item_id] > boundary:
                        errors.append(prefix + f"evidence {item_id} 越过生效时间边界")
            if visibility == "hidden":
                errors.append(prefix + "hidden evidence 不能作为可观察更新依据")
            intensity = event.get("emotion_intensity")
            if dim == "emotion":
                allowed = {None} if event.get("after") == "unknown" else {"low", "medium", "high"}
                if intensity not in allowed:
                    errors.append(prefix + "emotion_intensity 与 emotion 标签不匹配")
            elif intensity is not None:
                errors.append(prefix + "非 emotion delta 不应填写 intensity")
        for dim, values in objects.items():
            if len(values) > LIMITS[dim]:
                errors.append(f"{dim} active objects 超过上限 {LIMITS[dim]}")
        return errors

    def validate_review(self, trajectory_id: str, payload: dict, submit: bool) -> list[str]:
        expected = {event["event_id"]: event for event in self.events_by_trajectory.get(trajectory_id, [])}
        reviews = payload.get("reviews", [])
        added = payload.get("added_events", [])
        errors = []
        if not isinstance(reviews, list):
            return ["reviews 必须是数组"]
        if not isinstance(added, list):
            return ["added_events 必须是数组"]
        seen = set()
        for index, review in enumerate(reviews, 1):
            prefix = f"模型事件复核 {index}: "
            event_id = review.get("event_id")
            if event_id not in expected:
                errors.append(prefix + "event_id 不属于当前轨迹")
                continue
            if event_id in seen:
                errors.append(prefix + "event_id 重复")
            seen.add(event_id)
            decision = review.get("decision")
            if decision not in REVIEW_DECISIONS:
                if submit:
                    errors.append(prefix + "请选择保留、修改、存疑或排除")
                continue
            if decision == "edit":
                final_event = review.get("final_event")
                if not isinstance(final_event, dict):
                    if submit:
                        errors.append(prefix + "修改后必须提供 final_event")
                elif submit:
                    for error in self._validate_strict_event(trajectory_id, final_event):
                        errors.append(prefix + error)
            elif review.get("final_event") not in (None, {}):
                errors.append(prefix + "仅修改决定可以包含 final_event")
            if decision in {"ambiguous", "exclude"} and review.get("reason") not in REVIEW_REASONS:
                if submit:
                    errors.append(prefix + "存疑或排除时请选择原因")
        if submit:
            missing = sorted(set(expected) - seen)
            if missing:
                errors.append(f"还有 {len(missing)} 条模型事件未复核")
            if len(seen) != len(expected):
                errors.append("模型事件复核数量与当前任务不一致")
            for index, event in enumerate(added, 1):
                for error in self._validate_strict_event(trajectory_id, event):
                    errors.append(f"新增事件 {index}: " + error)
        return errors

    def _validate_strict_event(self, trajectory_id: str, event: dict) -> list[str]:
        trajectory = self.by_id[trajectory_id]
        errors = []
        dimension = event.get("dimension")
        if dimension not in LABELS:
            return ["dimension 非法"]
        if event.get("prior") not in LABELS[dimension] or event.get("after") not in LABELS[dimension]:
            errors.append("prior/after 不属于该维度")
        if "unknown" in {event.get("prior"), event.get("after")}:
            errors.append("严格事件不能使用 unknown 端点")
        if event.get("prior") == event.get("after"):
            errors.append("prior 与 after 必须不同")
        if dimension == "commitment" and event.get("after") == "withdrawn" and event.get("prior") not in {"conditional", "committed"}:
            errors.append("withdrawn 之前必须是 conditional 或 committed")
        if not str(event.get("object", "")).strip():
            errors.append("状态对象不能为空")
        if dimension == "emotion" and event.get("object") != "self":
            errors.append("emotion 的对象必须为 self")
        if event.get("effective_at") != "post_response":
            errors.append("严格事件只能在目标角色回复后生效")
        if event.get("visibility") not in {"direct", "reported", "inferred"}:
            errors.append("visibility 非法")
        if event.get("benchmark_value") not in {"core", "supporting"}:
            errors.append("benchmark_value 非法")
        if not str(event.get("evaluation_question", "")).strip():
            errors.append("评测问题不能为空")
        if not str(event.get("rationale", "")).strip():
            errors.append("评测价值说明不能为空")

        item_pos, item_meta, item_text = {}, {}, {}
        for round_ in trajectory["rounds"]:
            for slot, key in enumerate(("incoming", "target_response")):
                item = round_[key]
                item_pos[item["item_id"]] = (round_["round_id"], slot)
                item_meta[item["item_id"]] = (item["speaker"], key)
                item_text[item["item_id"]] = item["text"]
        try:
            boundary = (int(event.get("round_id")), 1)
        except (TypeError, ValueError):
            boundary = None
            errors.append("round_id 非法")
        valid_boundaries = {(round_["round_id"], 1) for round_ in trajectory["rounds"]}
        if boundary not in valid_boundaries:
            errors.append("round_id 不在当前对话中")

        prior = event.get("prior_evidence", [])
        after = event.get("after_evidence", [])
        if not isinstance(prior, list) or not prior:
            errors.append("至少需要一条前态证据")
            prior = []
        if not isinstance(after, list) or not after:
            errors.append("至少需要一条后态证据")
            after = []
        if set(prior) & set(after):
            errors.append("前态和后态证据不能重叠")
        for name, evidence in (("前态", prior), ("后态", after)):
            for item_id in evidence:
                if item_id not in item_pos:
                    errors.append(f"{name}证据不存在：{item_id}")
                elif item_meta[item_id] != (trajectory["target_character"], "target_response"):
                    errors.append(f"{name}证据必须是目标角色本人的回复")
        for name, field, evidence in (("前态", "prior_quote", prior), ("后态", "after_quote", after)):
            quote = str(event.get(field, "")).strip()
            if len(quote) < 3:
                errors.append(f"{name}必须填写原文短引文")
            elif not any(quote in item_text.get(item_id, "") for item_id in evidence):
                errors.append(f"{name}短引文必须原样出现在对应证据中")
        if boundary:
            if any(item_id in item_pos and item_pos[item_id] >= boundary for item_id in prior):
                errors.append("前态证据必须早于变化轮次")
            if any(item_id in item_pos and item_pos[item_id] > boundary for item_id in after):
                errors.append("后态证据不能晚于变化轮次")
            boundary_id = next((
                round_["target_response"]["item_id"] for round_ in trajectory["rounds"]
                if round_["round_id"] == boundary[0]
            ), None)
            if boundary_id not in after:
                errors.append("后态证据必须包含变化轮次的目标回复")
        return errors

    def _validate_events(self, trajectory_id: str, events: list[dict]) -> list[str]:
        return self.validate(trajectory_id, {"decision": "changes", "events": events, "notes": ""}, submit=True)

    def save(self, username: str, trajectory_id: str, payload: dict, expected_revision: int, submit: bool) -> tuple[dict | None, list[str]]:
        errors = self.validate(trajectory_id, payload, submit=submit)
        if errors:
            return None, errors
        canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        with closing(self.connect()) as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT revision FROM annotations WHERE username=? AND trajectory_id=?", (username, trajectory_id)
            ).fetchone()
            current = row[0] if row else 0
            if current != expected_revision:
                db.rollback()
                return None, [f"revision 冲突：服务器为 {current}，页面为 {expected_revision}，请刷新后重试"]
            revision = current + 1
            status = "submitted" if submit else "draft"
            submitted = "CURRENT_TIMESTAMP" if submit else "NULL"
            db.execute(
                f"""INSERT INTO annotations(username,trajectory_id,status,revision,payload,updated_at,submitted_at)
                VALUES(?,?,?,?,?,CURRENT_TIMESTAMP,{submitted})
                ON CONFLICT(username,trajectory_id) DO UPDATE SET
                    status=excluded.status,revision=excluded.revision,payload=excluded.payload,
                    updated_at=CURRENT_TIMESTAMP,submitted_at={submitted}""",
                (username, trajectory_id, status, revision, canonical),
            )
            db.execute(
                "INSERT INTO audit_log(username,trajectory_id,action,revision,payload_sha256) VALUES(?,?,?,?,?)",
                (username, trajectory_id, status, revision, hashlib.sha256(canonical.encode()).hexdigest()),
            )
            db.commit()
        return {"status": status, "revision": revision}, []

    def export(self) -> list[dict]:
        with closing(self.connect()) as db:
            rows = db.execute(
                "SELECT username,trajectory_id,status,revision,payload,updated_at,submitted_at FROM annotations ORDER BY username,trajectory_id"
            ).fetchall()
        return [
            {"annotator": r[0], "trajectory_id": r[1], "status": r[2], "revision": r[3],
             "annotation": json.loads(r[4]), "updated_at": r[5], "submitted_at": r[6]}
            for r in rows
        ]


class AppServer(ThreadingHTTPServer):
    def __init__(self, address, handler, store, auth):
        super().__init__(address, handler)
        self.store = store
        self.auth = auth


class Handler(BaseHTTPRequestHandler):
    server_version = "DRSTAnnotation/3.0"

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} [{self.log_date_time_string()}] {fmt % args}", flush=True)

    def send_json(self, value: object, status=200, headers=None):
        body = json_bytes(value)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'")
        for key, val in (headers or {}).items():
            self.send_header(key, val)
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 1_000_000:
                raise ValueError("request too large")
            return json.loads(self.rfile.read(length) or b"{}")
        except Exception as exc:
            self.send_json({"error": f"invalid JSON: {exc}"}, 400)
            return None

    def make_session(self, username: str, role: str):
        payload = {"u": username, "r": role, "exp": int(time.time()) + 12 * 3600, "csrf": secrets.token_urlsafe(24)}
        encoded = b64e(json_bytes(payload))
        sig = b64e(hmac.new(bytes.fromhex(self.server.auth["session_secret"]), encoded.encode(), hashlib.sha256).digest())
        return encoded + "." + sig, payload

    def auth_user(self):
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        morsel = cookie.get("drst_session")
        if not morsel:
            return None
        try:
            encoded, sig = morsel.value.split(".", 1)
            expected = b64e(hmac.new(bytes.fromhex(self.server.auth["session_secret"]), encoded.encode(), hashlib.sha256).digest())
            if not hmac.compare_digest(sig, expected):
                return None
            payload = json.loads(b64d(encoded))
            if payload["exp"] < time.time() or payload["u"] not in self.server.auth["users"]:
                return None
            return payload
        except Exception:
            return None

    def require_user(self, csrf=False):
        user = self.auth_user()
        if not user:
            self.send_json({"error": "authentication required"}, 401)
            return None
        if csrf and not hmac.compare_digest(self.headers.get("X-CSRF-Token", ""), user["csrf"]):
            self.send_json({"error": "invalid CSRF token"}, 403)
            return None
        return user

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            return self.send_json({"status": "ok", "service": "drst-annotation-v3"})
        if parsed.path == "/api/me":
            user = self.require_user()
            return None if not user else self.send_json({"username": user["u"], "role": user["r"], "csrf": user["csrf"]})
        if parsed.path == "/api/tasks":
            user = self.require_user()
            return None if not user else self.send_json({"tasks": self.server.store.list_tasks(user["u"])})
        if parsed.path.startswith("/api/tasks/"):
            user = self.require_user()
            if not user:
                return
            trajectory_id = parsed.path.removeprefix("/api/tasks/")
            result = self.server.store.get_task(user["u"], trajectory_id)
            return self.send_json(result if result else {"error": "not found"}, 200 if result else 404)
        if parsed.path == "/api/export":
            user = self.require_user()
            if not user:
                return
            if user["r"] != "admin":
                return self.send_json({"error": "admin required"}, 403)
            body = "".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in self.server.store.export()).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
            self.send_header("Content-Disposition", "attachment; filename=drst_annotations.jsonl")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return self.wfile.write(body)
        return self.serve_static(parsed.path)

    def serve_static(self, path: str):
        rel = "index.html" if path == "/" else path.lstrip("/")
        if rel not in {"index.html", "app.js", "style.css"}:
            return self.send_json({"error": "not found"}, 404)
        file_path = STATIC / rel
        body = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(file_path.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        parsed = urlparse(self.path)
        data = self.read_json()
        if data is None:
            return
        if parsed.path == "/api/login":
            username = str(data.get("username", ""))
            password = str(data.get("password", ""))
            record = self.server.auth["users"].get(username)
            valid = record and hmac.compare_digest(
                record["password_hash"], password_hash(password, record["salt"], record.get("iterations", 310_000))
            )
            if not valid:
                time.sleep(0.35)
                return self.send_json({"error": "用户名或密码错误"}, 401)
            token, session = self.make_session(username, record["role"])
            return self.send_json(
                {"username": username, "role": record["role"], "csrf": session["csrf"]},
                headers={"Set-Cookie": f"drst_session={token}; Path=/; Max-Age=43200; HttpOnly; Secure; SameSite=Strict"},
            )
        if parsed.path == "/api/logout":
            return self.send_json({"status": "ok"}, headers={"Set-Cookie": "drst_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict"})
        if parsed.path.startswith("/api/tasks/"):
            user = self.require_user(csrf=True)
            if not user:
                return
            trajectory_id = parsed.path.removeprefix("/api/tasks/")
            if trajectory_id not in self.server.store.by_id:
                return self.send_json({"error": "not found"}, 404)
            result, errors = self.server.store.save(
                user["u"], trajectory_id, data.get("payload", {}), int(data.get("revision", 0)), bool(data.get("submit"))
            )
            return self.send_json(result if result else {"error": "validation failed", "details": errors}, 200 if result else 422)
        return self.send_json({"error": "not found"}, 404)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--events", type=Path, default=DEFAULT_EVENTS)
    parser.add_argument("--state-dir", type=Path, default=DEFAULT_STATE)
    parser.add_argument("--db", type=Path, help="annotation database path; defaults to state-dir/review_v3.sqlite3")
    parser.add_argument("--only-with-events", action="store_true")
    parser.add_argument("--auth", type=Path, default=DEFAULT_STATE / "users.json")
    parser.add_argument("--cert", type=Path)
    parser.add_argument("--key", type=Path)
    args = parser.parse_args()
    auth = json.loads(args.auth.read_text(encoding="utf-8"))
    store = AnnotationStore(args.data, args.db or args.state_dir / "review_v3.sqlite3", args.events, args.only_with_events)
    server = AppServer((args.host, args.port), Handler, store, auth)
    scheme = "http"
    if args.cert and args.key:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(args.cert, args.key)
        server.socket = context.wrap_socket(server.socket, server_side=True)
        scheme = "https"
    print(f"DRST annotation server listening on {scheme}://{args.host}:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
