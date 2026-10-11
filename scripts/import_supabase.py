#!/usr/bin/env python3
"""One-time importer. Requires SUPABASE_SECRET_KEY only in this process env."""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_URL = "https://kuxfopfviczqstyhmaol.supabase.co"

def rows(path: Path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

def request(url: str, key: str, table: str, payload: list[dict]) -> None:
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    req = urllib.request.Request(
        f"{url.rstrip('/')}/rest/v1/{table}", data=data, method="POST",
        headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            if response.status not in {200, 201}: raise RuntimeError(f"{table}: HTTP {response.status}")
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"{table}: {exc.code} {exc.read().decode('utf-8', 'replace')}") from exc

def batches(values: list[dict], size: int = 100):
    for index in range(0, len(values), size): yield values[index:index + size]

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--trajectories", type=Path, required=True)
    parser.add_argument("--events", type=Path, required=True)
    parser.add_argument("--url", default=DEFAULT_URL)
    args = parser.parse_args()
    key = os.environ.get("SUPABASE_SECRET_KEY")
    if not key: raise SystemExit("SUPABASE_SECRET_KEY is required; do not put it in a command line or Git repository.")
    trajectories = rows(args.trajectories)
    events = rows(args.events)
    event_counts: dict[str, int] = {}
    for event in events: event_counts[event["trajectory_id"]] = event_counts.get(event["trajectory_id"], 0) + 1
    tasks = [{"trajectory_id": row["trajectory_id"], "source": row.get("source", {}).get("dataset", "unknown"), "target_character": row.get("target_character", "unknown"), "round_count": len(row.get("rounds", [])), "event_count": event_counts.get(row["trajectory_id"], 0), "payload": row} for row in trajectories if event_counts.get(row["trajectory_id"], 0)]
    event_rows = [{"event_id": row["event_id"], "trajectory_id": row["trajectory_id"], "round_id": int(row["round_id"]), "payload": row} for row in events]
    for batch in batches(tasks): request(args.url, key, "annotation_tasks", batch)
    for batch in batches(event_rows): request(args.url, key, "annotation_events", batch)
    print(json.dumps({"imported_tasks": len(tasks), "imported_events": len(event_rows)}, ensure_ascii=False))

if __name__ == "__main__": main()
