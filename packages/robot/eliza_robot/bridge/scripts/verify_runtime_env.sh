#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

missing=0

check_cmd() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then
    echo "[ok] command: $name"
  else
    echo "[missing] command: $name"
    missing=1
  fi
}

check_cmd python3
check_cmd roslaunch
check_cmd roscore
check_cmd xacro

echo
echo "Checking bridge Python dependencies..."
if python3 - <<'PY'
import importlib
modules = ["websockets"]
for m in modules:
    importlib.import_module(m)
print("ok")
PY
then
  echo "[ok] python deps: websockets"
else
  echo "[missing] python deps: websockets"
  missing=1
fi

echo
if [[ "$missing" -eq 0 ]]; then
  echo "runtime_env=PASS"
  exit 0
fi

echo "runtime_env=FAIL"
echo "Source your ROS environment and install missing dependencies."
exit 1
