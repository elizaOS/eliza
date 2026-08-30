#!/usr/bin/env sh
set -eu

# Bootstrap Tailscale/Headscale membership when Cloud injects TS_AUTHKEY. Kept
# behaviorally identical to deploy/cloud-agent-docker-entrypoint.sh so the
# canonical agent image and the bespoke cloud-agent image join the mesh the same
# way. Gated entirely on TS_AUTHKEY: images without it are unaffected.

# Distinct exit code for "the container cannot join the mesh because its baked
# pre-auth key has expired (or is otherwise rejected) and no persisted node
# identity could reconnect." A plain `exit 1` is indistinguishable from any
# other boot failure, so the control plane cannot tell a re-key-able node apart
# from a genuinely broken image and just restart-loops it forever (the prod-2
# hard-reset outage: a de-authorized node fell back to a 60-min key that had
# expired ~months earlier, and every restart replayed the same expired `up`).
# 78 == EX_CONFIG (sysexits.h): "configuration error" — the config (key) is
# stale, the image is fine. The daemon's health/orphan sweep keys off this code
# plus the marker file below to classify the container `auth_expired` and
# re-key/recreate it instead of leaving it in an unbounded crash loop.
TS_AUTHKEY_EXPIRED_EXIT_CODE=78

# `tailscale up` defaults to waiting forever for Running. A rejected pre-auth
# key can instead move the daemon to NeedsLogin with an interactive AuthURL,
# which must never hold the mesh-first container boot indefinitely. Keep every
# join attempt bounded; tests may lower this positive integer to exercise the
# deadline without delaying the suite.
TS_UP_TIMEOUT_SECONDS="${TS_UP_TIMEOUT_SECONDS:-120}"

# Substrings that mean "this auth key will never work on retry" — a fresh key is
# required, looping on the same one is pointless. Matched case-insensitively
# against the `tailscale up` stderr. Kept broad on purpose: headscale/tailscale
# phrase this as "authkey expired", "key expired", "authkey already used"
# (single-use key consumed by a prior boot), or "invalid key".
ts_interactive_auth_required() {
  case "$1" in
    *'"authurl": "http'*|*'"authurl":"http'*|*"authurl=true"*|*"authurl is http"*) return 0 ;;
    *"needsmachineauth"*) return 0 ;;
    *) return 1 ;;
  esac
}

ts_authkey_permanent_failure() {
  # $1 = combined tailscale up output (lower-cased by caller)
  case "$1" in
    *"authkey expired"*|*"auth key expired"*|*"key expired"*) return 0 ;;
    *"authkey already used"*|*"auth key already used"*) return 0 ;;
    *"invalid key"*|*"invalid authkey"*|*"invalid auth key"*) return 0 ;;
    *) ts_interactive_auth_required "$1" ;;
  esac
}

# Optional re-key hook. When HEADSCALE_REKEY_URL is set, a boot that can neither
# reconnect on persisted state NOR authenticate with the baked key will POST to
# it (Authorization: Bearer $HEADSCALE_REKEY_TOKEN, body {"hostname":...}) to
# request a FRESH pre-auth key, then retry `up` once with it. This is the
# self-healing path: a rebooted, de-authorized node re-keys itself without
# operator involvement. Left unset in environments without the endpoint, in
# which case the container fails fast with the distinct exit code above so the
# control plane can drive the recreate.
ts_try_fetch_fresh_authkey() {
  # $1 = hostname. Echoes the fresh key on stdout, empty on failure.
  rekey_url="${HEADSCALE_REKEY_URL:-}"
  [ -z "$rekey_url" ] && return 0
  command -v curl >/dev/null 2>&1 || return 0
  auth_header=""
  if [ -n "${HEADSCALE_REKEY_TOKEN:-}" ]; then
    auth_header="Authorization: Bearer ${HEADSCALE_REKEY_TOKEN}"
  fi
  # Best-effort: any failure yields an empty key and the caller falls through to
  # the distinct-exit path. -f so HTTP errors are non-zero, -s quiet, bounded.
  resp="$(
    curl -fsS --max-time 15 \
      ${auth_header:+-H "$auth_header"} \
      -H "Content-Type: application/json" \
      -X POST \
      --data "{\"hostname\":\"$1\"}" \
      "$rekey_url" 2>/dev/null || true
  )"
  [ -z "$resp" ] && return 0
  # Accept either a raw key string or a JSON body {"key":"tskey-..."} /
  # {"preAuthKey":{"key":"..."}}. Extract the first tskey-* token without a JSON
  # parser (busybox sh has none). Falls back to the whole trimmed body.
  fresh="$(printf '%s' "$resp" | grep -oE 'tskey-[A-Za-z0-9_-]+' | head -n 1 || true)"
  if [ -z "$fresh" ]; then
    fresh="$(printf '%s' "$resp" | tr -d ' \t\r\n')"
  fi
  printf '%s' "$fresh"
}

# Run `tailscale up`, capturing combined output so we can classify auth failures.
# JSON mode exposes the daemon's otherwise-interactive AuthURL / NeedsLogin
# state. Watch that output while the command is running so an unusable key fails
# immediately; the CLI's own timeout remains the hard bound for silent stalls.
# Args after the function name are passed through verbatim to `tailscale up`.
ts_up() {
  # Globals: ts_socket, ts_up_output (set here), ts_up_rc (set here).
  ts_up_output_file="/tmp/tailscale-up.$$.log"
  : > "$ts_up_output_file"
  chmod 600 "$ts_up_output_file"
  ts_daemon_log_start_line=$(( $(wc -l < /tmp/tailscaled.log 2>/dev/null || printf '0') + 1 ))

  # `up --json` intentionally suppresses its interactive URL when --auth-key
  # is present, so also inspect tailscaled's private log for the RegisterReq
  # authURL=true response. A fresh daemon normally passes through NeedsLogin
  # and may report machineAuthorized=false before the auth-key exchange
  # completes; neither transient signal is terminal by itself. That evidence
  # is never copied to container logs because the URL is an authorization secret.
  # shellcheck disable=SC2086
  tailscale --socket="$ts_socket" up \
    --json \
    --timeout="${TS_UP_TIMEOUT_SECONDS}s" \
    "$@" \
    >"$ts_up_output_file" 2>&1 &
  ts_up_pid=$!
  ts_up_auth_required=0
  ts_up_interactive_auth=0

  while kill -0 "$ts_up_pid" 2>/dev/null; do
    ts_up_snapshot="$(cat "$ts_up_output_file" 2>/dev/null || true)"
    ts_daemon_snapshot="$(tail -n +"$ts_daemon_log_start_line" /tmp/tailscaled.log 2>/dev/null || true)"
    ts_up_snapshot_lower="$(printf '%s\n%s' "$ts_up_snapshot" "$ts_daemon_snapshot" | tr '[:upper:]' '[:lower:]')"
    if [ -n "$ts_up_snapshot_lower" ] && ts_authkey_permanent_failure "$ts_up_snapshot_lower"; then
      ts_up_auth_required=1
      if ts_interactive_auth_required "$ts_up_snapshot_lower"; then
        ts_up_interactive_auth=1
      fi
      kill "$ts_up_pid" 2>/dev/null || true
      break
    fi
    sleep 0.1
  done

  if wait "$ts_up_pid"; then
    ts_up_rc=0
  else
    ts_up_rc=$?
  fi
  ts_up_output="$(cat "$ts_up_output_file" 2>/dev/null || true)"
  rm -f "$ts_up_output_file"
  ts_daemon_snapshot="$(tail -n +"$ts_daemon_log_start_line" /tmp/tailscaled.log 2>/dev/null || true)"
  ts_up_output_lower="$(printf '%s\n%s' "$ts_up_output" "$ts_daemon_snapshot" | tr '[:upper:]' '[:lower:]')"
  if [ -n "$ts_up_output_lower" ] && ts_authkey_permanent_failure "$ts_up_output_lower"; then
    ts_up_auth_required=1
    if ts_interactive_auth_required "$ts_up_output_lower"; then
      ts_up_interactive_auth=1
    fi
  fi
  if [ "$ts_up_auth_required" -eq 1 ]; then
    ts_up_rc=1
  else
    [ -n "$ts_up_output" ] && printf '%s\n' "$ts_up_output" >&2
  fi
  return 0
}

start_tailscale_if_configured() {
  if [ -z "${TS_AUTHKEY:-}" ]; then
    return 0
  fi

  if [ "$(id -u)" != "0" ]; then
    echo "[docker-entrypoint] TS_AUTHKEY is set but the container did not start as root" >&2
    exit 1
  fi

  if ! command -v tailscaled >/dev/null 2>&1 || ! command -v tailscale >/dev/null 2>&1; then
    echo "[docker-entrypoint] TS_AUTHKEY is set but tailscale/tailscaled is not installed" >&2
    exit 1
  fi

  case "$TS_UP_TIMEOUT_SECONDS" in
    ''|*[!0-9]*|0)
      echo "[docker-entrypoint] TS_UP_TIMEOUT_SECONDS must be a positive integer" >&2
      exit 1
      ;;
  esac

  ts_state_dir="${TS_STATE_DIR:-/var/lib/tailscale}"
  ts_socket="${TS_SOCKET:-/tmp/tailscaled.sock}"
  ts_hostname="${TS_HOSTNAME:-${SANDBOX_AGENT_ID:-${STEWARD_AGENT_ID:-$(hostname)}}}"
  ts_state_file="${ts_state_dir}/tailscaled.state"
  ts_authkey_expired_marker="${ts_state_dir}/authkey-expired"
  mkdir -p "$ts_state_dir"
  ts_had_persisted_state=0
  if [ -s "$ts_state_file" ]; then
    ts_had_persisted_state=1
  fi
  rm -f "$ts_socket"
  # Clear any stale marker from a previous boot: we re-derive status this run.
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
    echo "[docker-entrypoint] tailscaled did not create its socket; last log lines:" >&2
    tail -n 20 /tmp/tailscaled.log >&2 || true
    exit 1
  fi

  login_server_arg=""
  if [ -n "${HEADSCALE_URL:-}" ]; then
    login_server_arg="--login-server=${HEADSCALE_URL}"
  elif [ -n "${TS_CONTROL_URL:-}" ]; then
    login_server_arg="--login-server=${TS_CONTROL_URL}"
  fi

  # 1) RECONNECT-FIRST. If a persisted tailscaled.state already carries a node
  #    identity, prefer reconnecting on it and DO NOT present the baked auth key.
  #    Ordinary reboots re-register on this persisted identity; the baked
  #    single-use/short-TTL key is irrelevant to them and must not gate the boot.
  #    This is the common path across the fleet (nodes with multi-day uptime) and
  #    is exactly what a hard reset breaks by de-authorizing the node identity.
  #    Running `up` without --auth-key (and without --force-reauth) reuses the
  #    persisted identity instead of insisting on interactive re-login.
  # shellcheck disable=SC2086
  if [ "$ts_had_persisted_state" -eq 1 ]; then
    ts_up --hostname="$ts_hostname" $login_server_arg ${TS_EXTRA_ARGS:-}
    if [ "$ts_up_rc" -eq 0 ]; then
      echo "[docker-entrypoint] reconnected to headscale on persisted node identity" >&2
      return 0
    fi
    echo "[docker-entrypoint] persisted-state reconnect failed (rc=$ts_up_rc); falling back to auth key" >&2
  fi

  # 2) AUTH-KEY JOIN. No usable persisted identity (fresh container) or the
  #    reconnect above failed (hard reset de-authorized the node). Present the
  #    baked key.
  # shellcheck disable=SC2086
  ts_up --auth-key="$TS_AUTHKEY" --hostname="$ts_hostname" $login_server_arg ${TS_EXTRA_ARGS:-}
  if [ "$ts_up_rc" -eq 0 ]; then
    return 0
  fi

  ts_up_lower="$(printf '%s' "$ts_up_output" | tr '[:upper:]' '[:lower:]')"
  if [ "$ts_up_auth_required" -eq 1 ] || ts_authkey_permanent_failure "$ts_up_lower"; then
    # 3) SELF-HEAL via re-key hook (opt-in). Ask the control plane for a fresh
    #    key and retry ONCE before giving up.
    fresh_key="$(ts_try_fetch_fresh_authkey "$ts_hostname")"
    if [ -n "$fresh_key" ]; then
      echo "[docker-entrypoint] baked auth key rejected; retrying with freshly fetched key" >&2
      # shellcheck disable=SC2086
      ts_up --auth-key="$fresh_key" --hostname="$ts_hostname" $login_server_arg ${TS_EXTRA_ARGS:-}
      if [ "$ts_up_rc" -eq 0 ]; then
        return 0
      fi
      ts_up_lower="$(printf '%s' "$ts_up_output" | tr '[:upper:]' '[:lower:]')"
    fi

    # 4) DISTINCT AUTH-EXPIRED SIGNAL. Nothing worked and retrying is futile.
    #    Surface a machine-readable status the control plane can act on
    #    (re-key + recreate) instead of an unbounded restart loop on a dead key.
    if [ "$ts_up_interactive_auth" -eq 1 ]; then
      echo "[docker-entrypoint] tailscale requires interactive authorization (AuthURL/NeedsMachineAuth); unattended mesh join rejected" >&2
    fi
    echo "[docker-entrypoint] FATAL: headscale auth key expired/rejected and no persisted identity could reconnect; node needs re-keying" >&2
    printf 'auth_expired hostname=%s\n' "$ts_hostname" > "$ts_authkey_expired_marker" 2>/dev/null || true
    exit "$TS_AUTHKEY_EXPIRED_EXIT_CODE"
  fi

  # Non-auth failure (network blip, headscale unreachable): preserve the prior
  # contract — surface it and let the restart policy retry, which is the right
  # behavior for a transient error.
  echo "[docker-entrypoint] tailscale up failed (rc=$ts_up_rc, non-auth); see output above" >&2
  exit "$ts_up_rc"
}

resolved_port="${PORT:-${ELIZA_PORT:-2138}}"

export ELIZA_PORT="$resolved_port"
export ELIZA_PORT="${ELIZA_PORT:-$resolved_port}"
export ELIZA_API_PORT="${ELIZA_API_PORT:-$resolved_port}"

start_tailscale_if_configured

exec "$@"
