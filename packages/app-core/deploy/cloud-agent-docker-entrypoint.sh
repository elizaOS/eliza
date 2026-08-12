#!/usr/bin/env sh
set -eu

# Kept behaviorally identical to scripts/docker-entrypoint.sh (see that file for
# the full rationale on reconnect-first + distinct auth-expired signaling). The
# only delta is the final privilege drop to CLOUD_AGENT_RUN_AS_USER via gosu.
TS_AUTHKEY_EXPIRED_EXIT_CODE=78

ts_authkey_permanent_failure() {
  case "$1" in
    *"authkey expired"*|*"auth key expired"*|*"key expired"*) return 0 ;;
    *"authkey already used"*|*"auth key already used"*) return 0 ;;
    *"invalid key"*|*"invalid authkey"*|*"invalid auth key"*) return 0 ;;
    *) return 1 ;;
  esac
}

ts_try_fetch_fresh_authkey() {
  rekey_url="${HEADSCALE_REKEY_URL:-}"
  [ -z "$rekey_url" ] && return 0
  command -v curl >/dev/null 2>&1 || return 0
  auth_header=""
  if [ -n "${HEADSCALE_REKEY_TOKEN:-}" ]; then
    auth_header="Authorization: Bearer ${HEADSCALE_REKEY_TOKEN}"
  fi
  resp="$(
    curl -fsS --max-time 15 \
      ${auth_header:+-H "$auth_header"} \
      -H "Content-Type: application/json" \
      -X POST \
      --data "{\"hostname\":\"$1\"}" \
      "$rekey_url" 2>/dev/null || true
  )"
  [ -z "$resp" ] && return 0
  fresh="$(printf '%s' "$resp" | grep -oE 'tskey-[A-Za-z0-9_-]+' | head -n 1 || true)"
  if [ -z "$fresh" ]; then
    fresh="$(printf '%s' "$resp" | tr -d ' \t\r\n')"
  fi
  printf '%s' "$fresh"
}

ts_up() {
  ts_up_output="$(
    # shellcheck disable=SC2086
    tailscale --socket="$ts_socket" up "$@" 2>&1
  )" && ts_up_rc=0 || ts_up_rc=$?
  [ -n "$ts_up_output" ] && printf '%s\n' "$ts_up_output" >&2
  return 0
}

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
  ts_state_file="${ts_state_dir}/tailscaled.state"
  ts_authkey_expired_marker="${ts_state_dir}/authkey-expired"
  mkdir -p "$ts_state_dir"
  rm -f "$ts_socket"
  rm -f "$ts_authkey_expired_marker"

  tailscaled \
    --state="$ts_state_file" \
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

  # 1) RECONNECT-FIRST on persisted node identity (no auth key presented).
  # shellcheck disable=SC2086
  if [ -s "$ts_state_file" ]; then
    ts_up --hostname="$ts_hostname" $login_server_arg ${TS_EXTRA_ARGS:-}
    if [ "$ts_up_rc" -eq 0 ]; then
      echo "[cloud-agent-entrypoint] reconnected to headscale on persisted node identity" >&2
      return 0
    fi
    echo "[cloud-agent-entrypoint] persisted-state reconnect failed (rc=$ts_up_rc); falling back to auth key" >&2
  fi

  # 2) AUTH-KEY JOIN.
  # shellcheck disable=SC2086
  ts_up --auth-key="$TS_AUTHKEY" --hostname="$ts_hostname" $login_server_arg ${TS_EXTRA_ARGS:-}
  if [ "$ts_up_rc" -eq 0 ]; then
    return 0
  fi

  ts_up_lower="$(printf '%s' "$ts_up_output" | tr '[:upper:]' '[:lower:]')"
  if ts_authkey_permanent_failure "$ts_up_lower"; then
    # 3) SELF-HEAL via re-key hook (opt-in).
    fresh_key="$(ts_try_fetch_fresh_authkey "$ts_hostname")"
    if [ -n "$fresh_key" ]; then
      echo "[cloud-agent-entrypoint] baked auth key rejected; retrying with freshly fetched key" >&2
      # shellcheck disable=SC2086
      ts_up --auth-key="$fresh_key" --hostname="$ts_hostname" $login_server_arg ${TS_EXTRA_ARGS:-}
      if [ "$ts_up_rc" -eq 0 ]; then
        return 0
      fi
    fi

    # 4) DISTINCT AUTH-EXPIRED SIGNAL.
    echo "[cloud-agent-entrypoint] FATAL: headscale auth key expired/rejected and no persisted identity could reconnect; node needs re-keying" >&2
    printf 'auth_expired hostname=%s\n' "$ts_hostname" > "$ts_authkey_expired_marker" 2>/dev/null || true
    exit "$TS_AUTHKEY_EXPIRED_EXIT_CODE"
  fi

  echo "[cloud-agent-entrypoint] tailscale up failed (rc=$ts_up_rc, non-auth); see output above" >&2
  exit "$ts_up_rc"
}

start_tailscale_if_configured

run_as_user="${CLOUD_AGENT_RUN_AS_USER:-agent}"
if [ "$(id -u)" = "0" ] && [ -n "$run_as_user" ]; then
  exec gosu "$run_as_user" "$@"
fi

exec "$@"
