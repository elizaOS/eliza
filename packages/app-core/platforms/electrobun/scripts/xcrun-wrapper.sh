#!/usr/bin/env bash
set -euo pipefail

REAL_XCRUN="${ELECTROBUN_REAL_XCRUN:-/usr/bin/xcrun}"

if [[ "${1:-}" == "notarytool" && "${2:-}" == "submit" ]]; then
  args=("$@")
  has_output_format=0

  for arg in "${args[@]}"; do
    if [[ "$arg" == "--output-format" || "$arg" == "-f" ]]; then
      has_output_format=1
      break
    fi
  done

  if [[ "$has_output_format" -eq 0 ]]; then
    args+=("--output-format" "json")
  fi

  temp_output="$(mktemp)"
  status=0

  if ! "$REAL_XCRUN" "${args[@]}" >"$temp_output" 2>&1; then
    status=$?
  fi

  /usr/bin/python3 - "$temp_output" "$status" <<'PY'
import json
import pathlib
import sys

output_path = pathlib.Path(sys.argv[1])
status = int(sys.argv[2])
raw = output_path.read_text(encoding="utf-8", errors="replace").strip()

if not raw:
    if status != 0:
        print("notarytool submit failed with no output", file=sys.stderr)
    sys.exit(status)

try:
    payload = json.loads(raw)
except json.JSONDecodeError:
    lines = raw.splitlines()
    preview = "\n".join(lines[:40])
    stream = sys.stderr if status != 0 else sys.stdout
    print(preview, file=stream)
    sys.exit(status)

submission_id = (
    payload.get("id")
    or payload.get("submissionId")
    or payload.get("uuid")
    or payload.get("notarizationId")
    or ""
)
status_text = payload.get("status") or payload.get("message") or ""

if submission_id:
    print(f"id: {submission_id}")
if status_text:
    print(f"Current status: {status_text}")

if status != 0:
    issues = payload.get("issues")
    if issues:
        print("issues:", file=sys.stderr)
        for issue in issues[:10]:
            message = issue.get("message") or json.dumps(issue, ensure_ascii=True)
            print(f"  - {message}", file=sys.stderr)

sys.exit(status)
PY

  rm -f "$temp_output"
  exit "$status"
fi

exec "$REAL_XCRUN" "$@"
