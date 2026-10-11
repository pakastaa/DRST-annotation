#!/usr/bin/env python3
"""Create DRST tables and import local review tasks through Supabase Management API.

The management token stays in a local mode-0600 file. It is never written to
the repository, command line, output, or browser bundle.
"""
from __future__ import annotations

import argparse
import json
import urllib.error
import urllib.request
from pathlib import Path

PROJECT_REF = "kuxfopfviczqstyhmaol"
MANAGEMENT_URL = f"https://api.supabase.com/v1/projects/{PROJECT_REF}/database/query"
HERE = Path(__file__).resolve().parent

def load_rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

def literal(value: object) -> str:
    """Return a SQL literal for fixed data values produced locally."""
    if value is None:
        return "null"
    if isinstance(value, int):
        return str(value)
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return "'" + text.replace("'", "''") + "'"

def execute(token: str, query: str) -> object:
    request = urllib.request.Request(
        MANAGEMENT_URL,
        data=json.dumps({"query": query}).encode("utf-8"),
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        raise RuntimeError(f"Supabase Management API returned {exc.code}: {detail}") from exc

def groups(values: list[dict], size: int = 20):
    for start in range(0, len(values), size):
        yield values[start:start + size]

def insert_tasks(token: str, tasks: list[dict]) -> None:
    for rows in groups(tasks):
        values = ",\n".join(
            "(" + ",".join((literal(row["trajectory_id"]), literal(row["source"]), literal(row["target_character"]), str(row["round_count"]), str(row["event_count"]), literal(row["payload"]) + "::jsonb")) + ")"
            for row in rows
        )
        execute(token, """insert into public.annotation_tasks
          (trajectory_id, source, target_character, round_count, event_count, payload)
          values """ + values + """
          on conflict (trajectory_id) do update set
            source = excluded.source, target_character = excluded.target_character,
            round_count = excluded.round_count, event_count = excluded.event_count, payload = excluded.payload;""")

def insert_events(token: str, events: list[dict]) -> None:
    for rows in groups(events):
        values = ",\n".join(
            "(" + ",".join((literal(row["event_id"]), literal(row["trajectory_id"]), str(row["round_id"]), literal(row["payload"]) + "::jsonb")) + ")"
            for row in rows
        )
        execute(token, """insert into public.annotation_events
          (event_id, trajectory_id, round_id, payload)
          values """ + values + """
          on conflict (event_id) do update set
            trajectory_id = excluded.trajectory_id, round_id = excluded.round_id, payload = excluded.payload;""")

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--token-file", type=Path, required=True, help="local Supabase Management PAT file, mode 0600")
    parser.add_argument("--trajectories", type=Path, required=True)
    parser.add_argument("--events", type=Path, required=True)
    args = parser.parse_args()
    if not args.token_file.is_file():
        raise SystemExit(f"token file not found: {args.token_file}")
    if args.token_file.stat().st_mode & 0o077:
        raise SystemExit("refusing token file readable by group or others; set mode 0600")
    token = args.token_file.read_text(encoding="utf-8").strip()
    if not token:
        raise SystemExit("token file is empty")
    execute(token, (HERE.parent / "supabase" / "schema.sql").read_text(encoding="utf-8"))
    trajectories = load_rows(args.trajectories)
    events = load_rows(args.events)
    count_by_trajectory: dict[str, int] = {}
    for event in events:
        count_by_trajectory[event["trajectory_id"]] = count_by_trajectory.get(event["trajectory_id"], 0) + 1
    tasks = [{
        "trajectory_id": row["trajectory_id"],
        "source": row.get("source", {}).get("dataset", "unknown"),
        "target_character": row.get("target_character", "unknown"),
        "round_count": len(row.get("rounds", [])),
        "event_count": count_by_trajectory.get(row["trajectory_id"], 0),
        "payload": row,
    } for row in trajectories if count_by_trajectory.get(row["trajectory_id"], 0)]
    event_rows = [{"event_id": row["event_id"], "trajectory_id": row["trajectory_id"], "round_id": int(row["round_id"]), "payload": row} for row in events]
    insert_tasks(token, tasks)
    insert_events(token, event_rows)
    counts = execute(token, "select (select count(*) from public.annotation_tasks) as tasks, (select count(*) from public.annotation_events) as events;")
    print(json.dumps({"status": "ready", "expected_tasks": len(tasks), "expected_events": len(event_rows), "database": counts}, ensure_ascii=False))

if __name__ == "__main__":
    main()
