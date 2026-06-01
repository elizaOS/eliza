#!/usr/bin/env sh
set -eu

start_tailscale_if_configured() {
  if [ -z "${TS_AUTHKEY:-}" ]; then
    return 0
  fi

  if [ "$(id -u)" != "0" ]; then
    echo "[cloud-agent-entrypoint] TS_AUTHKEY is set but the container did not start as root" >&2
    exit 1
  fi

  if ! command -v tailscaled >/dev/null 2>&1 || ! command -v tailscale >/dev/null 2>&1; then
    echo "[cloud-agent-entrypoint] TS_AUTHKEY is set but tailscale/tailscaled is not installed" >&2
    exit 1
  fi

  ts_state_dir="${TS_STATE_DIR:-/var/lib/tailscale}"
  ts_socket="${TS_SOCKET:-/tmp/tailscaled.sock}"
  ts_hostname="${TS_HOSTNAME:-${SANDBOX_AGENT_ID:-${STEWARD_AGENT_ID:-$(hostname)}}}"
  mkdir -p "$ts_state_dir"
  rm -f "$ts_socket"

  tailscaled \
    --state="${ts_state_dir}/tailscaled.state" \
    --socket="$ts_socket" \
    >/tmp/tailscaled.log 2>&1 &

  export TS_SOCKET="$ts_socket"

  i=0
  while [ ! -S "$ts_socket" ] && [ ! -e "$ts_socket" ] && [ "$i" -lt 50 ]; do
    sleep 0.1
    i=$((i + 1))
  done

  if [ ! -S "$ts_socket" ] && [ ! -e "$ts_socket" ]; then
    echo "[cloud-agent-entrypoint] tailscaled did not create its socket; last log lines:" >&2
    tail -n 20 /tmp/tailscaled.log >&2 || true
    exit 1
  fi

  login_server_arg=""
  if [ -n "${HEADSCALE_URL:-}" ]; then
    login_server_arg="--login-server=${HEADSCALE_URL}"
  elif [ -n "${TS_CONTROL_URL:-}" ]; then
    login_server_arg="--login-server=${TS_CONTROL_URL}"
  fi

  # TS_EXTRA_ARGS intentionally supports multiple CLI flags, e.g. "--accept-routes".
  # shellcheck disable=SC2086
  tailscale --socket="$ts_socket" up \
    --auth-key="$TS_AUTHKEY" \
    --hostname="$ts_hostname" \
    $login_server_arg \
    ${TS_EXTRA_ARGS:-}
}

start_tailscale_if_configured

run_as_user="${CLOUD_AGENT_RUN_AS_USER:-agent}"
if [ "$(id -u)" = "0" ] && [ -n "$run_as_user" ]; then
  exec gosu "$run_as_user" "$@"
fi

exec "$@"
