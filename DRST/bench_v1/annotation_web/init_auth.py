#!/usr/bin/env python3
"""Create local annotation accounts without storing plaintext passwords."""
from __future__ import annotations

import argparse
import json
import os
import secrets
from pathlib import Path

from server import password_hash


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    if args.output.exists() and not args.force:
        raise SystemExit(f"refusing to overwrite {args.output}; use --force intentionally")
    credentials = {}
    users = {}
    for username, role in (("annotator_a", "annotator"), ("annotator_b", "annotator"), ("drst_admin", "admin")):
        password = secrets.token_urlsafe(18)
        salt = secrets.token_hex(16)
        credentials[username] = password
        users[username] = {"role": role, "salt": salt, "iterations": 310_000, "password_hash": password_hash(password, salt)}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({"session_secret": secrets.token_hex(32), "users": users}, indent=2) + "\n", encoding="utf-8")
    os.chmod(args.output, 0o600)
    credential_path = args.output.with_name("initial_credentials.txt")
    credential_path.write_text("\n".join(f"{user}: {password}" for user, password in credentials.items()) + "\n", encoding="utf-8")
    os.chmod(credential_path, 0o600)
    print(json.dumps({"auth_file": str(args.output), "credentials_file": str(credential_path)}, indent=2))


if __name__ == "__main__":
    main()
