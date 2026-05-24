#!/usr/bin/env bash
# start-eliza-agent-riscv64.sh
#
# Start the on-device Eliza app on a live CVD and verify its local agent is
# verify it is reachable from the host. Pairs with
# install-eliza-apk-riscv64.sh and agent-smoke-riscv64.sh.
#
# Steps:
#   1. launch the exported app activity; MainActivity starts the private
#      ElizaAgentService from the app UID on branded AOSP
#   2. poll pidof <package> for up to --service-wait seconds; bail if empty
#   3. adb forward tcp:31337 tcp:31337 (override via --host-port/--device-port)
#   4. curl http://127.0.0.1:31337/api/health; assert HTTP 200
#
# This script does not write evidence by itself. agent-smoke-riscv64.sh is
# responsible for the archived cuttlefish-agent smoke transcript under
# packages/chip/docs/evidence/android/eliza_ai_soc_cuttlefish_agent_smoke.log.

set -euo pipefail

usage() {
	cat >&2 <<'USAGE'
usage: start-eliza-agent-riscv64.sh [options]

Start the Eliza app on a CVD and verify /api/health returns
HTTP 200.

options:
  --serial=SERIAL          adb serial (default: AOSP_ADB_SERIAL or unset)
  --package=NAME           package whose pid is polled
                           (default: ai.milady.milady)
  --service=COMPONENT      expected private service component, recorded for
                           evidence only (default: ai.milady.milady/.ElizaAgentService)
  --host-port=N            host TCP port for adb forward (default: 31337)
  --device-port=N          device TCP port (default: 31337)
  --service-wait=SECONDS   max wait for pidof <package> (default: 60)
  --port-wait=SECONDS      max wait for /api/health HTTP 200 (default: 60)
  --help                   this message
USAGE
}

serial=${AOSP_ADB_SERIAL:-}
package=${AOSP_AGENT_PACKAGE:-ai.milady.milady}
service=${AOSP_AGENT_SERVICE:-ai.milady.milady/.ElizaAgentService}
host_port=${AOSP_AGENT_HOST_PORT:-31337}
device_port=${AOSP_AGENT_DEVICE_PORT:-31337}
service_wait=${AOSP_AGENT_SERVICE_WAIT_SECONDS:-60}
port_wait=${AOSP_AGENT_PORT_WAIT_SECONDS:-60}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--serial=*) serial=${1#*=}; shift ;;
		--package=*) package=${1#*=}; shift ;;
		--service=*) service=${1#*=}; shift ;;
		--host-port=*) host_port=${1#*=}; shift ;;
		--device-port=*) device_port=${1#*=}; shift ;;
		--service-wait=*) service_wait=${1#*=}; shift ;;
		--port-wait=*) port_wait=${1#*=}; shift ;;
		--help|-h) usage; exit 0 ;;
		*) echo "error: unknown option $1" >&2; usage; exit 2 ;;
	esac
done

for n in "$host_port" "$device_port" "$service_wait" "$port_wait"; do
	case "$n" in
		*[!0-9]*|"") echo "error: numeric option got $n" >&2; exit 2 ;;
	esac
done

log() { printf 'start-eliza-agent %s %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
fail() { printf 'start-eliza-agent error: %s\n' "$*" >&2; exit 1; }

if ! command -v adb >/dev/null 2>&1; then
	fail "adb not on PATH; source build/envsetup.sh from the AOSP tree first"
fi
if ! command -v curl >/dev/null 2>&1; then
	fail "curl not on PATH; install curl on the host"
fi

adb_cmd() {
	if [ -n "$serial" ]; then
		adb -s "$serial" "$@"
	else
		adb "$@"
	fi
}

log "service=$service package=$package host_port=$host_port device_port=$device_port"

abi=$(adb_cmd shell getprop ro.product.cpu.abi 2>/dev/null | tr -d '\r')
log "ro.product.cpu.abi=$abi"
if [ "$abi" != "riscv64" ]; then
	fail "device ABI is '$abi', expected riscv64"
fi

# Launch the exported app surface. The agent service is private by design;
# MainActivity starts it from the app UID on branded AOSP images.
adb_cmd shell monkey -p "$package" -c android.intent.category.LAUNCHER 1 >/dev/null

# Poll pidof for up to service_wait seconds.
deadline=$(( $(date +%s) + service_wait ))
agent_pid=
while :; do
	agent_pid=$(adb_cmd shell pidof "$package" 2>/dev/null | tr -d '\r' | awk '{print $1}')
	if [ -n "$agent_pid" ]; then
		break
	fi
	now=$(date +%s)
	if [ "$now" -ge "$deadline" ]; then
		fail "pidof $package returned empty within ${service_wait}s; service failed to start"
	fi
	sleep 2
done
log "AGENT_PID=$agent_pid"

# Forward host port to device port.
adb_cmd forward "tcp:$host_port" "tcp:$device_port" >/dev/null
log "adb forward tcp:$host_port -> tcp:$device_port"

# Poll /api/health.
health_url="http://127.0.0.1:$host_port/api/health"
body_file=$(mktemp "${TMPDIR:-/tmp}/start-eliza-agent.XXXXXX.json")
trap 'rm -f "$body_file"' EXIT
deadline=$(( $(date +%s) + port_wait ))
last_code=0
while :; do
	last_code=$(curl -s -o "$body_file" -w "%{http_code}" --max-time 10 "$health_url" || echo 0)
	if [ "$last_code" = "200" ]; then
		break
	fi
	now=$(date +%s)
	if [ "$now" -ge "$deadline" ]; then
		fail "/api/health returned HTTP $last_code after ${port_wait}s"
	fi
	sleep 2
done
log "AGENT_HEALTH_HTTP=$last_code"

# Validate response shape when the health endpoint returns JSON.
if ! python3 - "$body_file" <<'PY'
import json, sys
body = open(sys.argv[1], 'rb').read()
if not body.strip():
	raise SystemExit(0)
try:
	data = json.loads(body)
except json.JSONDecodeError:
	raise SystemExit(0)
if not isinstance(data, dict):
	raise SystemExit("health body is not a JSON object")
status = data.get("status")
if status is not None and status not in {"ok", "ready"}:
	raise SystemExit(f"health status={status!r}, expected 'ok' or 'ready'")
PY
then
	cat "$body_file" >&2
	fail "/api/health body did not match the expected shape"
fi

log "/api/health verified"
