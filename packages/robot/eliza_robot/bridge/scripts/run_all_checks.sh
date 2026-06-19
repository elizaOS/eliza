#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "[1/7] Unit and integration tests"
PYTHONPATH=. python3 -m unittest discover -s bridge/tests -p "test_*.py"

echo "[2/7] Python syntax compile check"
python3 -m compileall bridge

echo "[3/7] Launch config validation"
PYTHONPATH=. python3 -m bridge.launch --list-targets

echo "[4/7] IsaacLab config dry-run"
PYTHONPATH=. python3 -m bridge.isaaclab.run_sim --dry-run

echo "[5/7] Smoke test (mock backend)"
PYTHONPATH=. python3 -m bridge.rosbridge_server --backend mock --host 127.0.0.1 --port 19101 --publish-hz 20.0 >/tmp/bridge-mock.log 2>&1 &
MOCK_PID=$!
sleep 1
PYTHONPATH=. python3 -m bridge.tools.rosbridge_smoke --uri ws://127.0.0.1:19101
kill "$MOCK_PID" || true

echo "[6/7] Smoke test (isaac backend)"
PYTHONPATH=. python3 -m bridge.rosbridge_server --backend isaac --host 127.0.0.1 --port 19102 --publish-hz 20.0 >/tmp/bridge-isaac.log 2>&1 &
ISAAC_PID=$!
sleep 1
PYTHONPATH=. python3 -m bridge.tools.rosbridge_smoke --uri ws://127.0.0.1:19102
kill "$ISAAC_PID" || true

echo "[7/7] Parity test (mock vs isaac)"
PYTHONPATH=. python3 -m bridge.rosbridge_server --backend mock --host 127.0.0.1 --port 19103 --publish-hz 20.0 >/tmp/bridge-parity-mock.log 2>&1 &
PARITY_MOCK_PID=$!
PYTHONPATH=. python3 -m bridge.rosbridge_server --backend isaac --host 127.0.0.1 --port 19104 --publish-hz 20.0 >/tmp/bridge-parity-isaac.log 2>&1 &
PARITY_ISAAC_PID=$!
sleep 1
PYTHONPATH=. python3 -m bridge.tools.rosbridge_parity --left-uri ws://127.0.0.1:19103 --right-uri ws://127.0.0.1:19104
kill "$PARITY_MOCK_PID" || true
kill "$PARITY_ISAAC_PID" || true

echo "all_checks=PASS"
