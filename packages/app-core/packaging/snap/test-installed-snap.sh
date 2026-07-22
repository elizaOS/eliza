#!/usr/bin/env bash
# Exercises the installed Snap as a user would, while preserving stdout,
# stderr, and exit status separately for every command used as evidence.
# The lifecycle fixture changes only Snap metadata; it verifies snapd's local
# refresh/revert mechanics without pretending to be a prior product release.
set -euo pipefail

: "${SNAP_PATH:?SNAP_PATH must point to the built Snap}"
: "${EXPECTED_VERSION:?EXPECTED_VERSION must be the packaged version}"
: "${EXPECTED_ARCH:?EXPECTED_ARCH must be amd64 or arm64}"
: "${EVIDENCE_DIR:?EVIDENCE_DIR must retain the installed-runtime logs}"

test -f "$SNAP_PATH"
case "$EXPECTED_ARCH" in
  amd64) EXPECTED_NODE_ARCH=x64 ;;
  arm64) EXPECTED_NODE_ARCH=arm64 ;;
  *)
    echo "Unsupported expected architecture: $EXPECTED_ARCH" >&2
    exit 1
    ;;
esac

mkdir -p "$EVIDENCE_DIR"
SNAP_PATH="$(realpath "$SNAP_PATH")"
RUNTIME_PID=""
CLEAN_CWD=""

cleanup() {
  local exit_status=$?
  # error-policy:J6 CI teardown must preserve the original proof failure.
  set +e
  if [[ -n "$RUNTIME_PID" ]] && kill -0 "$RUNTIME_PID" 2>/dev/null; then
    kill "$RUNTIME_PID"
    wait "$RUNTIME_PID"
  fi
  snap list elizaos-app >"$EVIDENCE_DIR/final-snap-list.stdout" 2>"$EVIDENCE_DIR/final-snap-list.stderr"
  snap connections elizaos-app >"$EVIDENCE_DIR/final-snap-connections.stdout" 2>"$EVIDENCE_DIR/final-snap-connections.stderr"
  if [[ -n "$CLEAN_CWD" ]] && [[ -d "$CLEAN_CWD" ]]; then
    chmod 0755 "$CLEAN_CWD"
  fi
  exit "$exit_status"
}
trap cleanup EXIT

run_capture() {
  local label="$1"
  shift
  local stdout_file="$EVIDENCE_DIR/${label}.stdout"
  local stderr_file="$EVIDENCE_DIR/${label}.stderr"
  local status_file="$EVIDENCE_DIR/${label}.status"
  local command_status

  if "$@" >"$stdout_file" 2>"$stderr_file"; then
    command_status=0
  else
    command_status=$?
  fi
  printf '%s\n' "$command_status" | tee "$status_file"
  sed -n '1,200p' "$stdout_file"
  sed -n '1,200p' "$stderr_file" >&2
  test "$command_status" -eq 0
}

installed_snap_version() {
  snap list elizaos-app | awk 'NR == 2 { print $2 }'
}

echo "=== Install exact artifact ==="
sudo snap install "$SNAP_PATH" --dangerous
run_capture installed-list snap list elizaos-app
test "$(installed_snap_version)" = "$EXPECTED_VERSION"

echo "=== Offline commands from an empty read-only working directory ==="
sudo snap disconnect elizaos-app:network
sudo snap disconnect elizaos-app:network-bind
run_capture offline-connections snap connections elizaos-app
grep -Eq '^network[[:space:]]+elizaos-app:network[[:space:]]+-[[:space:]]+-' "$EVIDENCE_DIR/offline-connections.stdout"
grep -Eq '^network-bind[[:space:]]+elizaos-app:network-bind[[:space:]]+-[[:space:]]+-' "$EVIDENCE_DIR/offline-connections.stdout"

CLEAN_CWD="$HOME/eliza-snap-empty-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-${EXPECTED_ARCH}"
mkdir -p "$CLEAN_CWD"
test -z "$(find "$CLEAN_CWD" -mindepth 1 -print -quit)"
chmod 0555 "$CLEAN_CWD"
pushd "$CLEAN_CWD" >/dev/null
run_capture version snap run elizaos-app --version
run_capture help snap run elizaos-app --help
# These expansions belong to the shell inside the installed Snap, not this
# workflow shell, so the single quotes are an intentional execution boundary.
# shellcheck disable=SC2016
run_capture bundled-node snap run --shell elizaos-app -c '$SNAP/node/bin/node --version'
# shellcheck disable=SC2016
run_capture bundled-node-arch snap run --shell elizaos-app -c '$SNAP/node/bin/node -p process.arch'
# shellcheck disable=SC2016
run_capture bundled-bun snap run --shell elizaos-app -c '$SNAP/bun/bin/bun --version'
# shellcheck disable=SC2016
run_capture unicode-home snap run --shell elizaos-app -c 'UNICODE_HOME="$SNAP_USER_DATA/用户 home"; mkdir -p "$UNICODE_HOME"; HOME="$UNICODE_HOME" "$SNAP/bin/elizaos-app-wrapper" --version'
popd >/dev/null

VERSION_OUTPUT="$(tr -d '\r\n' <"$EVIDENCE_DIR/version.stdout")"
UNICODE_HOME_OUTPUT="$(tr -d '\r\n' <"$EVIDENCE_DIR/unicode-home.stdout")"
NODE_OUTPUT="$(tr -d '\r\n' <"$EVIDENCE_DIR/bundled-node.stdout")"
NODE_ARCH_OUTPUT="$(tr -d '\r\n' <"$EVIDENCE_DIR/bundled-node-arch.stdout")"
BUN_OUTPUT="$(tr -d '\r\n' <"$EVIDENCE_DIR/bundled-bun.stdout")"
test "$VERSION_OUTPUT" = "$EXPECTED_VERSION"
test "$UNICODE_HOME_OUTPUT" = "$EXPECTED_VERSION"
test "$NODE_OUTPUT" = "v24.15.0"
test "$NODE_ARCH_OUTPUT" = "$EXPECTED_NODE_ARCH"
test "$BUN_OUTPUT" = "1.3.14"
grep -q 'Usage:' "$EVIDENCE_DIR/help.stdout"
grep -q 'Commands:' "$EVIDENCE_DIR/help.stdout"

echo "=== Local refresh and rollback lifecycle ==="
LIFECYCLE_ROOT="$(mktemp -d "$RUNNER_TEMP/eliza-snap-lifecycle-root.XXXXXX")"
LIFECYCLE_OUTPUT="$(mktemp -d "$RUNNER_TEMP/eliza-snap-lifecycle-output.XXXXXX")"
unsquashfs -d "$LIFECYCLE_ROOT" "$SNAP_PATH" >/dev/null
sed -i "s/^version: .*/version: 0.0.1-lifecycle/" "$LIFECYCLE_ROOT/meta/snap.yaml"
snap pack "$LIFECYCLE_ROOT" "$LIFECYCLE_OUTPUT" | tee "$EVIDENCE_DIR/lifecycle-pack.stdout"
mapfile -t lifecycle_snaps < <(find "$LIFECYCLE_OUTPUT" -maxdepth 1 -type f -name '*.snap' -print)
test "${#lifecycle_snaps[@]}" -eq 1
LIFECYCLE_SNAP="${lifecycle_snaps[0]}"

sudo snap remove --purge elizaos-app
sudo snap install "$LIFECYCLE_SNAP" --dangerous
test "$(installed_snap_version)" = "0.0.1-lifecycle"
# snapd treats a second local install as a sideloaded refresh and allocates the
# next xN revision; `snap refresh` accepts store names, not local file paths.
sudo snap install "$SNAP_PATH" --dangerous
test "$(installed_snap_version)" = "$EXPECTED_VERSION"
sudo snap revert elizaos-app
test "$(installed_snap_version)" = "0.0.1-lifecycle"
sudo snap install "$SNAP_PATH" --dangerous
test "$(installed_snap_version)" = "$EXPECTED_VERSION"
run_capture lifecycle-list snap list --all elizaos-app

echo "=== Offline runtime startup and health ==="
# Local bind is required for the health probe; the general network plug stays
# disconnected so startup cannot depend on a provider, registry, or download.
sudo snap disconnect elizaos-app:network
sudo snap disconnect elizaos-app:network-bind
sudo snap connect elizaos-app:network-bind
run_capture startup-connections snap connections elizaos-app
grep -Eq '^network[[:space:]]+elizaos-app:network[[:space:]]+-[[:space:]]+-' "$EVIDENCE_DIR/startup-connections.stdout"

RUNTIME_PORT=31339
RUNTIME_LOG="$EVIDENCE_DIR/runtime.log"
ELIZA_API_PORT="$RUNTIME_PORT" \
ELIZA_PORT="$RUNTIME_PORT" \
ELIZA_AGENT_PORT="$RUNTIME_PORT" \
ELIZA_AGENT_CHARACTER_JSON='{"name":"SnapCiSmoke","bio":["Installed Snap CI boot probe."],"system":"You are a CI boot probe."}' \
ELIZA_STATE_DIR="$HOME/eliza-snap-state-${EXPECTED_ARCH}" \
ELIZA_CONFIG_DIR="$HOME/eliza-snap-config-${EXPECTED_ARCH}" \
ELIZA_WORKSPACE_DIR="$HOME/eliza-snap-workspace-${EXPECTED_ARCH}" \
ELIZA_VAULT_PASSPHRASE='snap-ci-vault-passphrase' \
ELIZA_DISABLE_LOCAL_EMBEDDINGS=1 \
snap run elizaos-app start >"$RUNTIME_LOG" 2>&1 &
RUNTIME_PID=$!
printf '%s\n' "$RUNTIME_PID" >"$EVIDENCE_DIR/runtime.pid"

HEALTH_READY=false
for _attempt in $(seq 1 120); do
  if ! kill -0 "$RUNTIME_PID" 2>/dev/null; then
    if wait "$RUNTIME_PID"; then
      EARLY_RUNTIME_STATUS=0
    else
      EARLY_RUNTIME_STATUS=$?
    fi
    printf '%s\n' "$EARLY_RUNTIME_STATUS" >"$EVIDENCE_DIR/runtime-early-exit.status"
    RUNTIME_PID=""
    echo "Installed runtime exited before health became ready" >&2
    exit 1
  fi
  if HEALTH_CODE="$(curl --silent --show-error --output "$EVIDENCE_DIR/health.json" --write-out '%{http_code}' --connect-timeout 1 --max-time 3 "http://127.0.0.1:${RUNTIME_PORT}/api/health")"; then
    printf '%s\n' "$HEALTH_CODE" >"$EVIDENCE_DIR/health.status"
    if [[ "$HEALTH_CODE" = "200" ]] && node -e 'const body=JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); if (body.ready !== true) process.exit(1);' "$EVIDENCE_DIR/health.json"; then
      HEALTH_READY=true
      break
    fi
  fi
  sleep 2
done
test "$HEALTH_READY" = true
sed -n '1,240p' "$RUNTIME_LOG"
sed -n '1,240p' "$EVIDENCE_DIR/health.json"

kill "$RUNTIME_PID"
if wait "$RUNTIME_PID"; then
  RUNTIME_STATUS=0
else
  RUNTIME_STATUS=$?
fi
RUNTIME_PID=""
printf '%s\n' "$RUNTIME_STATUS" | tee "$EVIDENCE_DIR/runtime-shutdown.status"
case "$RUNTIME_STATUS" in
  0 | 143) ;;
  *)
    echo "Unexpected runtime shutdown status: $RUNTIME_STATUS" >&2
    exit 1
    ;;
esac

echo "=== Uninstall ==="
sudo snap remove --purge elizaos-app
if snap list elizaos-app >"$EVIDENCE_DIR/uninstall.stdout" 2>"$EVIDENCE_DIR/uninstall.stderr"; then
  echo "elizaos-app remained installed after snap remove --purge" >&2
  exit 1
fi
printf 'removed\n' >"$EVIDENCE_DIR/uninstall.status"
