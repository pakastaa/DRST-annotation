#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

python -m py_compile \
  DRST/bench_v1/annotation_web/server.py \
  DRST/bench_v1/annotation_web/init_auth.py \
  scripts/import_supabase.py
node --check DRST/bench_v1/annotation_web/static/app.js
node --check pages/app.js

for forbidden in dataset outputs runtime users.json initial_credentials.txt; do
  if git ls-files | grep -Eq "(^|/)${forbidden}(/|$)"; then
    echo "forbidden tracked path: ${forbidden}" >&2
    exit 1
  fi
done

if git ls-files | grep -Eq '\.(sqlite3|db|key|pem|crt|p12|jsonl)$'; then
  echo "forbidden runtime or secret file is tracked" >&2
  exit 1
fi

echo "checkout validation passed"
