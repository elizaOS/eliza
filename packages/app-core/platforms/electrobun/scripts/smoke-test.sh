#!/usr/bin/env bash
# smoke-test.sh — Build and verify the signed Electrobun .app bundle locally.
#
# Usage:
#   bash apps/app/electrobun/scripts/smoke-test.sh
#
# Pre-requisites (macOS):
#   - Bun installed
#   - Xcode Command Line Tools installed (for codesign, spctl, xcrun)
#   - Signing identity in Keychain (for codesign check to pass)
#     OR run without signing: set SKIP_SIGNATURE_CHECK=1
#
# What this script does:
#   1. Builds the core server bundle + renderer assets that Electrobun copies
#   2. Bundles runtime node_modules into dist/
#   3. Builds the native macOS effects dylib
#   4. Runs electrobun build (--env=canary by default)
#   5. Locates the built .app bundle from artifacts/ or mounts the built DMG
#   6. Verifies codesign + notarization
#   7. Launches the app, waits for the embedded backend to answer /api/health,
#      then confirms the app stays alive and kills it

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTROBUN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

has_electrobun_workspace_root() {
  local candidate="$1"
  [[ -f "$candidate/bun.lock" ]] || return 1
  [[ -f "$candidate/package.json" ]] || return 1
  [[ -f "$candidate/packages/app/package.json" || -f "$candidate/apps/app/package.json" ]] || return 1
  [[ -f "$candidate/packages/app-core/platforms/electrobun/package.json" || -f "$candidate/eliza/packages/app-core/platforms/electrobun/package.json" ]] || return 1
}

has_outer_eliza_electrobun_checkout() {
  local candidate="$1"
  [[ -f "$candidate/eliza/packages/app-core/platforms/electrobun/package.json" ]]
}

find_electrobun_workspace_root() {
  local current="$ELECTROBUN_DIR"
  local matches=()

  while true; do
    if has_electrobun_workspace_root "$current"; then
      matches+=("$current")
    fi

    local parent
    parent="$(dirname "$current")"
    if [[ "$parent" == "$current" ]]; then
      local match
      for match in "${matches[@]}"; do
        if has_outer_eliza_electrobun_checkout "$match"; then
          printf "%s\n" "$match"
          return 0
        fi
      done
      if [[ "${#matches[@]}" -gt 0 ]]; then
        printf "%s\n" "${matches[0]}"
        return 0
      fi
      echo "ERROR: Could not locate Electrobun workspace root from $ELECTROBUN_DIR" >&2
      return 1
    fi

    current="$parent"
  done
}

REPO_ROOT="${ELIZA_ELECTROBUN_REPO_ROOT:-$(find_electrobun_workspace_root)}"
if ! has_electrobun_workspace_root "$REPO_ROOT"; then
  echo "ERROR: ELIZA_ELECTROBUN_REPO_ROOT is not an Electrobun workspace root: $REPO_ROOT" >&2
  exit 1
fi
APP_DIR="${ELIZA_ELECTROBUN_APP_DIR:-}"
if [[ -z "$APP_DIR" ]]; then
  if [[ -f "$REPO_ROOT/packages/app/package.json" ]]; then
    APP_DIR="$REPO_ROOT/packages/app"
  else
    APP_DIR="$REPO_ROOT/apps/app"
  fi
fi
COMMON_BUILD_ENV=(ELIZA_ELECTROBUN_REPO_ROOT="$REPO_ROOT")
if [[ -f "$REPO_ROOT/eliza/packages/app-core/package.json" && -z "${ELIZA_ELIZA_SOURCE:-}" && -z "${ELIZA_SOURCE:-}" ]]; then
  COMMON_BUILD_ENV+=(ELIZA_ELIZA_SOURCE="local")
fi
BUILD_ENV="${BUILD_ENV:-canary}"
SKIP_SIGNATURE_CHECK="${SKIP_SIGNATURE_CHECK:-0}"
SKIP_BUILD="${SKIP_BUILD:-0}"
STARTUP_TIMEOUT="${STARTUP_TIMEOUT:-900}"
LIVENESS_TIMEOUT="${LIVENESS_TIMEOUT:-8}"
PACKAGED_HANDOFF_GRACE_SECONDS="${PACKAGED_HANDOFF_GRACE_SECONDS:-90}"
BUILD_SKIP_CODESIGN="${ELECTROBUN_SKIP_CODESIGN:-}"
BUILD_DEVELOPER_ID="${ELECTROBUN_DEVELOPER_ID:-}"
ARTIFACTS_DIR_OVERRIDE="${ARTIFACTS_DIR:-}"
SMOKE_DIAGNOSTICS_DIR="${SMOKE_DIAGNOSTICS_DIR:-}"
EXPECTED_BUNDLE_IDENTIFIER="${EXPECTED_BUNDLE_IDENTIFIER:-com.elizaai.eliza}"
MOUNT_POINT=""
LAUNCH_APP_BUNDLE=""
STARTUP_LOG="$HOME/.config/Eliza/eliza-startup.log"
STARTUP_LOG_CANDIDATES=(
  "$HOME/.config/elizaOS/eliza-startup.log"
  "$HOME/.config/Eliza/eliza-startup.log"
)
STARTUP_SESSION_ID=""
STARTUP_STATE_FILE=""
STARTUP_EVENTS_FILE=""
STARTUP_BOOTSTRAP_FILE=""
STARTUP_CONTROL_BOOTSTRAP_FILES=(
  "$HOME/.config/elizaOS/startup-session.json"
  "$HOME/.config/Eliza/startup-session.json"
)
MAC_DIRECT_EXEC_PROBE_RC=""
MAC_LAUNCH_MODE="${ELIZA_SMOKE_MAC_LAUNCH_MODE:-auto}"
OPEN_LAUNCH_OUTPUT=""
OPEN_LAUNCH_ATTEMPTED="0"
OPEN_LAUNCH_EXIT_CODE=""
STATE_PHASE=""
STATE_PORT=""
STATE_PID=""
STATE_CHILD_PID=""
STATE_ERROR=""
STATE_EXIT_CODE=""
STATE_UPDATED_AT=""
STATE_SOURCE_FILE=""
DEFAULT_AVATAR_ASSET_SLUGS=(eliza-1 eliza-1)

if [[ "$SKIP_SIGNATURE_CHECK" == "1" && -z "$BUILD_SKIP_CODESIGN" ]]; then
  BUILD_SKIP_CODESIGN="1"
fi

if [[ "$(uname)" == "Darwin" && "$BUILD_SKIP_CODESIGN" != "1" && -z "$BUILD_DEVELOPER_ID" ]]; then
  BUILD_DEVELOPER_ID="$(
    security find-identity -v -p codesigning 2>/dev/null \
      | grep "Developer ID Application" \
      | head -1 \
      | sed 's/.*"\(.*\)"/\1/' || true
  )"
  if [[ -z "$BUILD_DEVELOPER_ID" && -z "${CI:-}" && -z "${GITHUB_ACTIONS:-}" ]]; then
    echo "ERROR: No Developer ID Application identity found."
    echo "       \`bun run test:desktop:packaged\` is the strict signed-packaged gate."
    echo "       Use \`bun run test:desktop:packaged:unsigned\` for ad-hoc local smoke,"
    echo "       or set ELECTROBUN_DEVELOPER_ID / ELECTROBUN_SKIP_CODESIGN explicitly."
    exit 1
  fi
fi

if [[ "$BUILD_SKIP_CODESIGN" == "1" || "$SKIP_SIGNATURE_CHECK" == "1" ]]; then
  echo "WARNING: Running unsigned/ad-hoc packaged smoke. This is not a release-grade signing/notarization check."
fi

cleanup() {
  kill_stale_processes
  if [[ -n "$STARTUP_BOOTSTRAP_FILE" ]]; then
    rm -f "$STARTUP_BOOTSTRAP_FILE"
  fi
  local startup_control_file=""
  for startup_control_file in "${STARTUP_CONTROL_BOOTSTRAP_FILES[@]}"; do
    if [[ -n "$STARTUP_SESSION_ID" && -f "$startup_control_file" ]] && grep -q "$STARTUP_SESSION_ID" "$startup_control_file" 2>/dev/null; then
      rm -f "$startup_control_file"
    fi
  done
  if [[ -n "$LAUNCH_APP_BUNDLE" && "$LAUNCH_APP_BUNDLE" == /tmp/* && -d "$LAUNCH_APP_BUNDLE" ]]; then
    rm -rf "$LAUNCH_APP_BUNDLE"
  fi
  if [[ -n "$MOUNT_POINT" && -d "$MOUNT_POINT" ]]; then
    hdiutil detach "$MOUNT_POINT" >/dev/null 2>&1 || true
  fi
}

attach_dmg_with_retry() {
  local dmg_path="$1"
  local attempts="${2:-5}"
  local sleep_seconds="${3:-2}"
  local attempt=1
  local attach_output=""
  local mount_point=""

  while [[ "$attempt" -le "$attempts" ]]; do
    if attach_output="$(hdiutil attach -nobrowse -readonly "$dmg_path" 2>&1)"; then
      mount_point="$(printf "%s\n" "$attach_output" | awk '/\/Volumes\// { print substr($0, index($0, "/Volumes/")); exit }')"
      if [[ -n "$mount_point" && -d "$mount_point" ]]; then
        printf "%s\n" "$mount_point"
        return 0
      fi
      echo "WARNING: DMG attach succeeded but no mount point was detected (attempt $attempt/$attempts)." >&2
    else
      echo "WARNING: DMG attach failed (attempt $attempt/$attempts):" >&2
      printf "%s\n" "$attach_output" >&2
    fi

    if [[ "$attempt" -lt "$attempts" ]]; then
      sleep "$sleep_seconds"
    fi
    attempt=$((attempt + 1))
  done

  return 1
}

backend_health_probe_status() {
  local url="$1"
  curl -sS -o /dev/null -w "%{http_code}" --connect-timeout 3 "$url" 2>/dev/null || printf "000"
}

backend_health_probe_satisfied() {
  local url="$1"
  local status
  status="$(backend_health_probe_status "$url")"
  # A 401 still proves the packaged backend is running and enforcing auth.
  [[ "$status" == "200" || "$status" == "401" ]]
}

ensure_diagnostics_dir() {
  if [[ -z "$SMOKE_DIAGNOSTICS_DIR" ]]; then
    SMOKE_DIAGNOSTICS_DIR="$(mktemp -d /tmp/eliza-smoke-diagnostics.XXXXXX)"
  fi
  mkdir -p "$SMOKE_DIAGNOSTICS_DIR"
}

init_startup_session() {
  ensure_diagnostics_dir
  STARTUP_SESSION_ID="${ELIZA_STARTUP_SESSION_ID:-eliza-smoke-${BUILD_ENV}-$$-${RANDOM:-0}-$(date +%s)}"
  STARTUP_STATE_FILE="$SMOKE_DIAGNOSTICS_DIR/startup-state.json"
  STARTUP_EVENTS_FILE="$SMOKE_DIAGNOSTICS_DIR/startup-events.jsonl"
  STARTUP_BOOTSTRAP_FILE="$LAUNCH_APP_BUNDLE/Contents/Resources/startup-session.json"
  rm -f "$STARTUP_STATE_FILE" "$STARTUP_EVENTS_FILE"
  mkdir -p "$(dirname "$STARTUP_BOOTSTRAP_FILE")"
  local bootstrap_temp="${STARTUP_BOOTSTRAP_FILE}.tmp.$$"
  node -e '
    const fs = require("node:fs");
    const [filePath, sessionId, stateFile, eventsFile] = process.argv.slice(1);
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    fs.writeFileSync(
      filePath,
      `${JSON.stringify(
        {
          session_id: sessionId,
          state_file: stateFile,
          events_file: eventsFile,
          expires_at: expiresAt,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  ' "$bootstrap_temp" "$STARTUP_SESSION_ID" "$STARTUP_STATE_FILE" "$STARTUP_EVENTS_FILE"
  mv "$bootstrap_temp" "$STARTUP_BOOTSTRAP_FILE"

  local startup_control_file=""
  for startup_control_file in "${STARTUP_CONTROL_BOOTSTRAP_FILES[@]}"; do
    mkdir -p "$(dirname "$startup_control_file")"
    cp "$STARTUP_BOOTSTRAP_FILE" "$startup_control_file"
  done
}

load_startup_state() {
  STATE_PHASE=""
  STATE_PORT=""
  STATE_PID=""
  STATE_CHILD_PID=""
  STATE_ERROR=""
  STATE_EXIT_CODE=""
  STATE_UPDATED_AT=""
  STATE_SOURCE_FILE=""

  local startup_state_file="$STARTUP_STATE_FILE"
  if [[ ! -f "$startup_state_file" ]]; then
    return 1
  fi

  local -a startup_state_parts=()
  local startup_state_line=""
  # macOS runners still default to Bash 3.2, so avoid Bash-4-only mapfile.
  while IFS= read -r startup_state_line; do
    startup_state_parts+=("$startup_state_line")
  done < <(
    node -e '
      const fs = require("node:fs");
      const [filePath, expectedSession] = process.argv.slice(1);
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if ((data.session_id ?? "") !== expectedSession) {
        process.exit(2);
      }
      const fields = [
        data.phase ?? "",
        data.port ?? "",
        data.pid ?? "",
        data.child_pid ?? "",
        String(data.error ?? "").replace(/\r?\n/g, " "),
        data.exit_code ?? "",
        data.updated_at ?? "",
      ];
      for (const field of fields) {
        console.log(String(field));
      }
    ' "$startup_state_file" "$STARTUP_SESSION_ID" 2>/dev/null || true
  )
  if [[ "${#startup_state_parts[@]}" -eq 0 ]]; then
    return 1
  fi

  STATE_SOURCE_FILE="$startup_state_file"
  STATE_PHASE="${startup_state_parts[0]:-}"
  STATE_PORT="${startup_state_parts[1]:-}"
  STATE_PID="${startup_state_parts[2]:-}"
  STATE_CHILD_PID="${startup_state_parts[3]:-}"
  STATE_ERROR="${startup_state_parts[4]:-}"
  STATE_EXIT_CODE="${startup_state_parts[5]:-}"
  STATE_UPDATED_AT="${startup_state_parts[6]:-}"
  return 0
}

collect_recent_crash_reports() {
  if [[ "$(uname)" != "Darwin" ]]; then
    return 0
  fi

  ensure_diagnostics_dir
  local crash_dir="$HOME/Library/Logs/DiagnosticReports"
  [[ -d "$crash_dir" ]] || return 0

  while IFS= read -r crash_file; do
    cp "$crash_file" "$SMOKE_DIAGNOSTICS_DIR/" 2>/dev/null || true
  done < <(
    find "$crash_dir" -maxdepth 1 -type f \( -name "*.crash" -o -name "*.ips" \) 2>/dev/null | sort | tail -n 10
  )
}

copy_supporting_diagnostics() {
  ensure_diagnostics_dir

  local startup_log_candidate=""
  for startup_log_candidate in "${STARTUP_LOG_CANDIDATES[@]}"; do
    if [[ -f "$startup_log_candidate" ]]; then
      cp "$startup_log_candidate" "$SMOKE_DIAGNOSTICS_DIR/$(basename "$(dirname "$startup_log_candidate")")-eliza-startup.log" 2>/dev/null || true
    fi
  done
  if [[ -f "$STARTUP_STATE_FILE" ]]; then
    cp "$STARTUP_STATE_FILE" "$SMOKE_DIAGNOSTICS_DIR/startup-state.json" 2>/dev/null || true
  fi
  if [[ -f "$STARTUP_EVENTS_FILE" ]]; then
    cp "$STARTUP_EVENTS_FILE" "$SMOKE_DIAGNOSTICS_DIR/startup-events.jsonl" 2>/dev/null || true
  fi
  if [[ -f "$STARTUP_BOOTSTRAP_FILE" ]]; then
    cp "$STARTUP_BOOTSTRAP_FILE" "$SMOKE_DIAGNOSTICS_DIR/startup-session.json" 2>/dev/null || true
  fi
  local startup_control_file=""
  for startup_control_file in "${STARTUP_CONTROL_BOOTSTRAP_FILES[@]}"; do
    if [[ -f "$startup_control_file" ]]; then
      cp "$startup_control_file" "$SMOKE_DIAGNOSTICS_DIR/$(basename "$(dirname "$startup_control_file")")-startup-session.json" 2>/dev/null || true
    fi
  done
  if [[ -n "$OPEN_LAUNCH_OUTPUT" && -f "$OPEN_LAUNCH_OUTPUT" ]]; then
    cp "$OPEN_LAUNCH_OUTPUT" "$SMOKE_DIAGNOSTICS_DIR/open.stderr" 2>/dev/null || true
  fi

  while IFS= read -r wrapper_file; do
    [[ -z "$wrapper_file" ]] && continue
    local relative_path
    relative_path="${wrapper_file#"$ELECTROBUN_DIR"/}"
    relative_path="${relative_path#"$APP_DIR"/}"
    relative_path="${relative_path#"$REPO_ROOT"/}"
    relative_path="${relative_path#/}"
    local destination_dir="$SMOKE_DIAGNOSTICS_DIR/$(dirname "$relative_path")"
    mkdir -p "$destination_dir"
    cp "$wrapper_file" "$destination_dir/" 2>/dev/null || true
  done < <(
    find "$ELECTROBUN_DIR/build" -type f -name "wrapper-diagnostics.json" 2>/dev/null | sort
  )
}

write_bundle_diagnostics() {
  ensure_diagnostics_dir
  local diagnostics_file="$SMOKE_DIAGNOSTICS_DIR/bundle-diagnostics.txt"
  : >"$diagnostics_file"

  {
    echo "Bundle: $LAUNCH_APP_BUNDLE"
    echo "Launcher: ${LAUNCHER_PATH:-<unset>}"
    echo ""

    if [[ -d "$LAUNCH_APP_BUNDLE/Contents/MacOS" ]]; then
      echo "Contents/MacOS:"
      find "$LAUNCH_APP_BUNDLE/Contents/MacOS" -maxdepth 2 -type f | sort
      echo ""
    fi

    if [[ -d "$LAUNCH_APP_BUNDLE/Contents/Resources" ]]; then
      echo "Contents/Resources:"
      find "$LAUNCH_APP_BUNDLE/Contents/Resources" -maxdepth 2 | sort
      echo ""
    fi
  } >>"$diagnostics_file"

  for candidate in \
    "$LAUNCH_APP_BUNDLE/Contents/MacOS/launcher" \
    "$LAUNCH_APP_BUNDLE/Contents/MacOS/bun" \
    "$LAUNCH_APP_BUNDLE/Contents/MacOS/libwebgpu_dawn.dylib" \
    "$LAUNCH_APP_BUNDLE/Contents/MacOS/libNativeWrapper.dylib" \
    "$LAUNCH_APP_BUNDLE/Contents/MacOS/zig-zstd" \
    "$LAUNCH_APP_BUNDLE/Contents/MacOS/bspatch"
  do
    if [[ ! -e "$candidate" ]]; then
      continue
    fi

    {
      echo "=== $candidate ==="
      file "$candidate" 2>&1 || true
      lipo -info "$candidate" 2>&1 || true
      otool -L "$candidate" 2>&1 || true
      codesign -dv --verbose=4 "$candidate" 2>&1 || true
      echo ""
    } >>"$diagnostics_file"
  done

  if [[ -n "${RUNTIME_ARCHIVE:-}" && -f "$RUNTIME_ARCHIVE" ]]; then
    {
      echo "=== $RUNTIME_ARCHIVE ==="
      tar --zstd -tf "$RUNTIME_ARCHIVE" 2>&1 | sed -n '1,120p'
      echo ""
    } >>"$diagnostics_file"
  fi
}

dump_failure_diagnostics() {
  local reason="$1"
  local launcher_stdout="${LAUNCHER_STDOUT:-}"
  local launcher_stderr="${LAUNCHER_STDERR:-}"
  load_startup_state || true
  ensure_diagnostics_dir
  write_bundle_diagnostics
  collect_recent_crash_reports
  copy_supporting_diagnostics

  {
    echo "Reason: $reason"
    echo "Build env: $BUILD_ENV"
    echo "Startup timeout: $STARTUP_TIMEOUT"
    echo "Liveness timeout: $LIVENESS_TIMEOUT"
    echo "Packaged handoff grace: $PACKAGED_HANDOFF_GRACE_SECONDS"
    echo "Startup session: ${STARTUP_SESSION_ID:-<none>}"
    echo "Startup state file: ${STARTUP_STATE_FILE:-<unset>}"
    echo "Startup events file: ${STARTUP_EVENTS_FILE:-<unset>}"
    echo "Startup bootstrap file: ${STARTUP_BOOTSTRAP_FILE:-<unset>}"
    echo "Startup control bootstrap files: ${STARTUP_CONTROL_BOOTSTRAP_FILES[*]:-<unset>}"
    echo "Loaded startup state source: ${STATE_SOURCE_FILE:-<none>}"
    echo "Mac launch mode: ${MAC_LAUNCH_MODE:-<unset>}"
    echo "open(1) attempted: ${OPEN_LAUNCH_ATTEMPTED:-0}"
    echo "open(1) exit code: ${OPEN_LAUNCH_EXIT_CODE:-<unset>}"
    echo "Mac direct bundle exec probe rc: ${MAC_DIRECT_EXEC_PROBE_RC:-<unset>}"
    echo "Mounted volume: ${MOUNT_POINT:-<none>}"
    echo "Launch bundle: ${LAUNCH_APP_BUNDLE:-<none>}"
    echo "Launcher path: ${LAUNCHER_PATH:-<none>}"
    echo "Launcher pid: ${PID:-<none>}"
    echo "Observed main pid: ${STATE_PID:-<none>}"
    echo "Observed child pid: ${STATE_CHILD_PID:-<none>}"
    echo "Observed phase: ${STATE_PHASE:-<none>}"
    echo "Observed port: ${STATE_PORT:-<none>}"
    echo "Observed exit code: ${STATE_EXIT_CODE:-<none>}"
    echo "Observed error: ${STATE_ERROR:-<none>}"
    echo "Fallback packaged PID: $(find_live_packaged_pid)"
    echo ""
    echo "Launcher stdout:"
    if [[ -n "$launcher_stdout" && -f "$launcher_stdout" ]]; then
      cat "$launcher_stdout" 2>/dev/null || true
    fi
    echo ""
    echo "Launcher stderr:"
    if [[ -n "$launcher_stderr" && -f "$launcher_stderr" ]]; then
      cat "$launcher_stderr" 2>/dev/null || true
    fi
    echo ""
    echo "open(1) stderr:"
    if [[ -n "$OPEN_LAUNCH_OUTPUT" && -f "$OPEN_LAUNCH_OUTPUT" ]]; then
      cat "$OPEN_LAUNCH_OUTPUT" 2>/dev/null || true
    fi
    echo ""
    echo "Startup state snapshot:"
    if [[ -f "$STARTUP_STATE_FILE" ]]; then
      cat "$STARTUP_STATE_FILE" 2>/dev/null || true
    fi
    echo ""
    echo "Startup bootstrap snapshot:"
    if [[ -f "$STARTUP_BOOTSTRAP_FILE" ]]; then
      cat "$STARTUP_BOOTSTRAP_FILE" 2>/dev/null || true
    fi
    echo ""
    echo "Startup session events:"
    if [[ -f "$STARTUP_EVENTS_FILE" ]]; then
      tail -n 200 "$STARTUP_EVENTS_FILE" 2>/dev/null || true
    fi
  } >"$SMOKE_DIAGNOSTICS_DIR/failure-summary.txt"

  echo "Diagnostics written to: $SMOKE_DIAGNOSTICS_DIR"
}

kill_stale_processes() {
  local pid=""
  local found=0

  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    if kill -0 "$pid" >/dev/null 2>&1; then
      if [[ $found -eq 0 ]]; then
        echo "Stopping stale Eliza launcher/backend processes..."
        found=1
      fi
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done < <(
    pgrep -f '/(Applications|tmp|private/tmp|Volumes)/.*([Ee]liza|elizaOS)[^/]*\.app/Contents/.*(launcher|bun|main\.js|entry\.js)|eliza-dist/entry\.js' || true
  )

  pid="$(lsof -nP -tiTCP:2138 -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  if [[ -n "$pid" ]]; then
    if [[ $found -eq 0 ]]; then
      echo "Stopping stale Eliza launcher/backend processes..."
      found=1
    fi
    kill "$pid" >/dev/null 2>&1 || true
  fi

  if [[ $found -eq 1 ]]; then
    sleep 2
  fi
}

escape_regex() {
  printf '%s' "$1" | sed -e 's/[][(){}.^$+*?|\\]/\\&/g'
}

build_launcher_command() {
  LAUNCH_COMMAND=("$LAUNCHER_PATH")

  # The Electrobun macOS launcher copies the inherited environment before it
  # spawns Bun. Large shell env blocks can crash the launcher in
  # std.process.getEnvMap() before our app code runs, so always launch macOS
  # smoke runs with a small user-like environment.
  if [[ "$(uname)" == "Darwin" ]]; then
    local launch_user=""
    local launch_path=""
    local launch_shell=""
    local launch_lang=""
    local launch_lc_all=""

    launch_user="${USER:-$(id -un 2>/dev/null || echo runner)}"
    launch_path="${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
    launch_shell="${SHELL:-/bin/bash}"
    launch_lang="${LANG:-en_US.UTF-8}"
    launch_lc_all="${LC_ALL:-$launch_lang}"

    LAUNCH_COMMAND=(
      /usr/bin/env
      -i
      HOME="$HOME"
      PATH="$launch_path"
      SHELL="$launch_shell"
      USER="$launch_user"
      LOGNAME="${LOGNAME:-$launch_user}"
      TMPDIR="${TMPDIR:-/tmp}"
      LANG="$launch_lang"
      LC_ALL="$launch_lc_all"
      TERM="${TERM:-dumb}"
      ELIZA_STARTUP_SESSION_ID="$STARTUP_SESSION_ID"
      ELIZA_STARTUP_STATE_FILE="$STARTUP_STATE_FILE"
      ELIZA_STARTUP_EVENTS_FILE="$STARTUP_EVENTS_FILE"
      ELIZA_FORCE_AUTOSTART_AGENT=1
      ELIZA_DESKTOP_SKIP_STARTUP_CRASH_PROMPT=1
      "$LAUNCHER_PATH"
    )
  else
    LAUNCH_COMMAND=(
      /usr/bin/env
      ELIZA_STARTUP_SESSION_ID="$STARTUP_SESSION_ID"
      ELIZA_STARTUP_STATE_FILE="$STARTUP_STATE_FILE"
      ELIZA_STARTUP_EVENTS_FILE="$STARTUP_EVENTS_FILE"
      ELIZA_FORCE_AUTOSTART_AGENT=1
      ELIZA_DESKTOP_SKIP_STARTUP_CRASH_PROMPT=1
      "$LAUNCHER_PATH"
    )
  fi
}

probe_macos_bundle_exec_support() {
  MAC_DIRECT_EXEC_PROBE_RC=""

  if [[ "$(uname)" != "Darwin" ]]; then
    return 0
  fi

  local probe_root=""
  local probe_exec=""
  probe_root="$(mktemp -d /tmp/eliza-smoke-probe.XXXXXX)"
  probe_exec="$probe_root/Probe.app/Contents/MacOS/hello"
  mkdir -p "$(dirname "$probe_exec")"
  cat >"$probe_exec" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$probe_exec"

  MAC_DIRECT_EXEC_PROBE_RC="$(
    node -e '
      const { spawnSync } = require("node:child_process");
      const { constants } = require("node:os");
      const result = spawnSync(process.argv[1], [], { stdio: "ignore" });
      if (typeof result.status === "number") {
        process.stdout.write(String(result.status));
        process.exit(0);
      }
      if (typeof result.signal === "string") {
        const signalCode = constants.signals?.[result.signal] ?? 0;
        process.stdout.write(String(128 + signalCode));
        process.exit(0);
      }
      process.stdout.write("1");
    ' "$probe_exec"
  )"
  rm -rf "$probe_root"

  [[ "$MAC_DIRECT_EXEC_PROBE_RC" == "0" ]]
}

launch_packaged_app_with_open() {
  OPEN_LAUNCH_ATTEMPTED="1"
  OPEN_LAUNCH_OUTPUT="$(mktemp /tmp/eliza-smoke-open.stderr.XXXXXX)"
  if /usr/bin/open -n "$LAUNCH_APP_BUNDLE" >"$LAUNCHER_STDOUT" 2>"$OPEN_LAUNCH_OUTPUT"; then
    OPEN_LAUNCH_EXIT_CODE="0"
  else
    OPEN_LAUNCH_EXIT_CODE="$?"
  fi
  PID=""
}

launch_packaged_app() {
  LAUNCHER_STDOUT="$(mktemp /tmp/eliza-smoke-launcher.stdout.XXXXXX)"
  LAUNCHER_STDERR="$(mktemp /tmp/eliza-smoke-launcher.stderr.XXXXXX)"

  if [[ "$(uname)" == "Darwin" ]]; then
    local requested_launch_mode="$MAC_LAUNCH_MODE"
    local effective_launch_mode="$requested_launch_mode"

    if [[ "$requested_launch_mode" == "auto" ]]; then
      if probe_macos_bundle_exec_support; then
        effective_launch_mode="direct"
      else
        effective_launch_mode="open"
      fi
    fi

    MAC_LAUNCH_MODE="$effective_launch_mode"
    if [[ "$MAC_LAUNCH_MODE" == "open" ]]; then
      launch_packaged_app_with_open
      return 0
    fi
  fi

  build_launcher_command
  "${LAUNCH_COMMAND[@]}" >"$LAUNCHER_STDOUT" 2>"$LAUNCHER_STDERR" &
  PID="$!"
}

find_live_packaged_pid() {
  if load_startup_state && [[ -n "$STATE_PID" ]] && kill -0 "$STATE_PID" >/dev/null 2>&1; then
    printf '%s\n' "$STATE_PID"
    return 0
  fi

  if [[ -z "$LAUNCH_APP_BUNDLE" ]]; then
    return 0
  fi

  local bundle_regex=""
  bundle_regex="$(escape_regex "$LAUNCH_APP_BUNDLE")"
  pgrep -f "${bundle_regex}/Contents/MacOS/launcher|${bundle_regex}/Contents/MacOS/bun|${bundle_regex}/Contents/Resources/main\\.js|${bundle_regex}/Contents/Resources/app/bun/index\\.js|${bundle_regex}/Contents/Resources/app/eliza-dist/entry\\.js" | head -1 || true
}

assert_packaged_asset() {
  local asset_path="$1"
  local description="$2"
  local min_size="${3:-1}"
  local size_bytes=""

  if [[ ! -f "$asset_path" ]]; then
    echo "ERROR: Missing packaged ${description}: $asset_path"
    dump_failure_diagnostics "missing packaged ${description}"
    exit 1
  fi

  size_bytes="$(wc -c < "$asset_path" | tr -d ' ')"
  if [[ -z "$size_bytes" || "$size_bytes" -lt "$min_size" ]]; then
    echo "ERROR: Packaged ${description} looks truncated (${size_bytes:-0} bytes): $asset_path"
    dump_failure_diagnostics "packaged ${description} failed size check"
    exit 1
  fi
}

assert_packaged_archive_asset() {
  local archive_path="$1"
  local archive_member="$2"
  local description="$3"
  local min_size="${4:-1}"
  local size_bytes=""

  if ! tar --zstd -tf "$archive_path" | grep -Fxq "$archive_member"; then
    echo "ERROR: Missing packaged ${description} in wrapper archive: $archive_member"
    dump_failure_diagnostics "missing packaged ${description} in wrapper archive"
    exit 1
  fi

  size_bytes="$(
    tar --zstd -xOf "$archive_path" "$archive_member" 2>/dev/null \
      | wc -c \
      | tr -d ' '
  )"
  if [[ -z "$size_bytes" || "$size_bytes" -lt "$min_size" ]]; then
    echo "ERROR: Packaged ${description} in wrapper archive looks truncated (${size_bytes:-0} bytes): $archive_member"
    dump_failure_diagnostics "packaged ${description} in wrapper archive failed size check"
    exit 1
  fi
}

assert_packaged_asset_variants() {
  local description="$1"
  local min_size="${2:-1}"
  shift 2

  local candidate=""
  local size_bytes=""
  local checked=()
  for candidate in "$@"; do
    checked+=("$candidate")
    if [[ ! -f "$candidate" ]]; then
      continue
    fi

    size_bytes="$(wc -c < "$candidate" | tr -d ' ')"
    if [[ -n "$size_bytes" && "$size_bytes" -ge "$min_size" ]]; then
      return 0
    fi
  done

  echo "ERROR: Missing packaged ${description}: ${checked[*]}"
  dump_failure_diagnostics "missing packaged ${description}"
  exit 1
}

assert_packaged_archive_asset_variants() {
  local archive_path="$1"
  local description="$2"
  local min_size="${3:-1}"
  shift 3

  local archive_member=""
  local size_bytes=""
  local checked=()
  for archive_member in "$@"; do
    checked+=("$archive_member")
    if ! tar --zstd -tf "$archive_path" | grep -Fxq "$archive_member"; then
      continue
    fi

    size_bytes="$(
      tar --zstd -xOf "$archive_path" "$archive_member" 2>/dev/null \
        | wc -c \
        | tr -d ' '
    )"
    if [[ -n "$size_bytes" && "$size_bytes" -ge "$min_size" ]]; then
      return 0
    fi
  done

  echo "ERROR: Missing packaged ${description} in wrapper archive: ${checked[*]}"
  dump_failure_diagnostics "missing packaged ${description} in wrapper archive"
  exit 1
}

verify_packaged_renderer_assets() {
  local renderer_dir="$LAUNCH_APP_BUNDLE/Contents/Resources/app/renderer"
  local archive_bundle_root=""
  local default_avatar_vrm_candidates=()
  local default_avatar_background_candidates=()
  local slug=""

  for slug in "${DEFAULT_AVATAR_ASSET_SLUGS[@]}"; do
    default_avatar_vrm_candidates+=(
      "$renderer_dir/vrms/${slug}.vrm.gz"
      "$renderer_dir/vrms/${slug}.vrm"
    )
    default_avatar_background_candidates+=("$renderer_dir/vrms/backgrounds/${slug}.png")
  done

  if [[ -d "$renderer_dir" ]]; then
    assert_packaged_asset "$renderer_dir/index.html" "renderer entrypoint" 256
    assert_packaged_asset_variants "default avatar VRM" 1024 \
      "${default_avatar_vrm_candidates[@]}"
    assert_packaged_asset_variants "default avatar background" 1024 \
      "${default_avatar_background_candidates[@]}"
    assert_packaged_asset_variants "default idle animation" 1024 \
      "$renderer_dir/animations/idle.glb.gz" \
      "$renderer_dir/animations/idle.glb"

    echo "Packaged renderer asset check PASSED (direct app bundle)."
    return 0
  fi

  if [[ -n "${RUNTIME_ARCHIVE:-}" && -f "$RUNTIME_ARCHIVE" ]]; then
    archive_bundle_root="$(basename "$LAUNCH_APP_BUNDLE")/Contents/Resources/app/renderer"
    default_avatar_vrm_candidates=()
    default_avatar_background_candidates=()
    for slug in "${DEFAULT_AVATAR_ASSET_SLUGS[@]}"; do
      default_avatar_vrm_candidates+=(
        "$archive_bundle_root/vrms/${slug}.vrm.gz"
        "$archive_bundle_root/vrms/${slug}.vrm"
      )
      default_avatar_background_candidates+=("$archive_bundle_root/vrms/backgrounds/${slug}.png")
    done
    assert_packaged_archive_asset "$RUNTIME_ARCHIVE" "$archive_bundle_root/index.html" "renderer entrypoint" 256
    assert_packaged_archive_asset_variants "$RUNTIME_ARCHIVE" "default avatar VRM" 1024 \
      "${default_avatar_vrm_candidates[@]}"
    assert_packaged_archive_asset_variants "$RUNTIME_ARCHIVE" "default avatar background" 1024 \
      "${default_avatar_background_candidates[@]}"
    assert_packaged_archive_asset_variants "$RUNTIME_ARCHIVE" "default idle animation" 1024 \
      "$archive_bundle_root/animations/idle.glb.gz" \
      "$archive_bundle_root/animations/idle.glb"

    echo "Packaged renderer asset check PASSED (wrapper archive)."
    return 0
  fi

  echo "ERROR: Packaged renderer directory missing and no wrapper archive was available: $renderer_dir"
  dump_failure_diagnostics "packaged renderer directory missing"
  exit 1
}

trap cleanup EXIT

echo "============================================================"
echo " Eliza Electrobun Smoke Test"
echo " Build env  : $BUILD_ENV"
echo " Working dir: $ELECTROBUN_DIR"
echo " Repo root  : $REPO_ROOT"
echo " App dir    : $APP_DIR"
echo "============================================================"
echo ""

# ── 1-4. Build or reuse packaged artifact ────────────────────────────────────
if [[ "$SKIP_BUILD" == "1" ]]; then
  echo "[1/7] Reusing existing packaged artifact (SKIP_BUILD=1)..."
else
  echo "[1/7] Building core dist + renderer assets..."
  (cd "$REPO_ROOT" && env "${COMMON_BUILD_ENV[@]}" bunx tsdown && echo '{"type":"module"}' > dist/package.json && env "${COMMON_BUILD_ENV[@]}" node --import tsx scripts/write-build-info.ts)
  (cd "$APP_DIR" && env "${COMMON_BUILD_ENV[@]}" npx vite build)
  echo ""

  echo "[2/7] Bundling runtime node_modules into dist/..."
  (cd "$REPO_ROOT" && env "${COMMON_BUILD_ENV[@]}" node --import tsx scripts/copy-runtime-node-modules.ts --scan-dir dist --target-dist dist)
  echo ""

  if [[ "$(uname)" == "Darwin" ]]; then
    echo "[3/7] Building native macOS effects dylib..."
    (cd "$ELECTROBUN_DIR" && bun run build:native-effects)
    DYLIB="$ELECTROBUN_DIR/src/libMacWindowEffects.dylib"
    if [[ ! -f "$DYLIB" ]]; then
      echo "ERROR: $DYLIB not found after build. Abort."
      exit 1
    fi
    echo "      OK — $DYLIB ($(du -sh "$DYLIB" | cut -f1))"
  else
    echo "[3/7] Skipping dylib build (not macOS)"
  fi
  echo ""

  echo "[4/7] Building Electrobun app (env=$BUILD_ENV)..."
  (cd "$ELECTROBUN_DIR" && env "${COMMON_BUILD_ENV[@]}" ELECTROBUN_DEVELOPER_ID="$BUILD_DEVELOPER_ID" ELECTROBUN_SKIP_CODESIGN="$BUILD_SKIP_CODESIGN" bun run build -- --env="$BUILD_ENV")
fi
echo ""

# ── 5. Locate built .app ─────────────────────────────────────────────────────
echo "[5/7] Locating built .app bundle..."
ARTIFACTS_DIR="${ARTIFACTS_DIR_OVERRIDE:-$ELECTROBUN_DIR/artifacts}"
LEGACY_DIST_DIR="$ELECTROBUN_DIR/dist"
OUTPUT_DIR=""

if [[ -d "$ARTIFACTS_DIR" ]]; then
  OUTPUT_DIR="$ARTIFACTS_DIR"
elif [[ -d "$LEGACY_DIST_DIR" ]]; then
  OUTPUT_DIR="$LEGACY_DIST_DIR"
  echo "WARNING: Falling back to legacy dist/ output; artifacts/ was not found."
else
  echo "ERROR: Neither $ARTIFACTS_DIR nor $LEGACY_DIST_DIR exists. Build may have failed."
  exit 1
fi

echo "Build output contents ($OUTPUT_DIR):"
find "$OUTPUT_DIR" -maxdepth 3 | sort

APP_BUNDLE=""
APP_BUNDLE_FALLBACK=""
while IFS= read -r -d '' f; do
  if [[ -z "$APP_BUNDLE_FALLBACK" ]]; then
    APP_BUNDLE_FALLBACK="$f"
  fi
  if [[ "$f" == *"/.dmg-staging/"* ]]; then
    continue
  fi
  APP_BUNDLE="$f"
done < <(find "$OUTPUT_DIR" -maxdepth 3 -name "*.app" -type d -print0 2>/dev/null)

if [[ -z "$APP_BUNDLE" ]]; then
  APP_BUNDLE="$APP_BUNDLE_FALLBACK"
fi

if [[ -z "$APP_BUNDLE" ]]; then
  DMG_PATH="$(find "$OUTPUT_DIR" -maxdepth 1 -name "*.dmg" -type f -print -quit 2>/dev/null || true)"
  if [[ -n "$DMG_PATH" && "$(uname)" == "Darwin" ]]; then
    echo "No .app bundle found in artifacts; mounting DMG: $DMG_PATH"
    MOUNT_POINT="$(attach_dmg_with_retry "$DMG_PATH")"
    if [[ -n "$MOUNT_POINT" && -d "$MOUNT_POINT" ]]; then
      APP_BUNDLE="$(find "$MOUNT_POINT" -maxdepth 2 -name "*.app" -type d -print -quit 2>/dev/null || true)"
    fi
  fi
fi

if [[ -z "$APP_BUNDLE" ]]; then
  echo "ERROR: No .app bundle found under $OUTPUT_DIR or inside the built DMG"
  exit 1
fi
echo "Found: $APP_BUNDLE"
echo "Size : $(du -sh "$APP_BUNDLE" | cut -f1)"

RUNTIME_ARCHIVE="$(find "$APP_BUNDLE/Contents/Resources" -maxdepth 1 -name "*.tar.zst" -type f -print -quit 2>/dev/null || true)"
DIRECT_WGPU_DYLIB="$APP_BUNDLE/Contents/MacOS/libwebgpu_dawn.dylib"
DIRECT_RUNTIME_DIR="$APP_BUNDLE/Contents/Resources/app/eliza-dist"
if [[ -n "$RUNTIME_ARCHIVE" ]]; then
  if ! tar --zstd -tf "$RUNTIME_ARCHIVE" | grep -q "Contents/MacOS/libwebgpu_dawn\\.dylib$"; then
    echo "ERROR: Bundled Dawn runtime not found inside $RUNTIME_ARCHIVE"
    exit 1
  fi
  echo "WGPU : wrapper bundle -> $RUNTIME_ARCHIVE"
elif [[ -f "$DIRECT_WGPU_DYLIB" && -d "$DIRECT_RUNTIME_DIR" ]]; then
  echo "WGPU : direct app bundle -> $DIRECT_WGPU_DYLIB"
else
  echo "ERROR: Neither a packaged runtime archive nor a direct WebGPU runtime was found in $APP_BUNDLE"
  exit 1
fi
echo ""

# ── 6. Signature + notarization check ────────────────────────────────────────
if [[ "$(uname)" == "Darwin" && "$SKIP_SIGNATURE_CHECK" != "1" ]]; then
  echo "[6/7] Verifying signature and notarization..."

  codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE"

  SIGN_INFO="$(codesign -dv --verbose=4 "$APP_BUNDLE" 2>&1 || true)"
  echo "$SIGN_INFO"
  if ! echo "$SIGN_INFO" | grep -q "Identifier=$EXPECTED_BUNDLE_IDENTIFIER"; then
    echo "ERROR: App bundle identifier mismatch. Expected $EXPECTED_BUNDLE_IDENTIFIER"
    exit 1
  fi

  for EXECUTABLE_PATH in \
    "$APP_BUNDLE/Contents/MacOS/launcher" \
    "$APP_BUNDLE/Contents/MacOS/bun"
  do
    if [[ ! -f "$EXECUTABLE_PATH" ]]; then
      continue
    fi

    EXECUTABLE_SIGN_INFO="$(codesign -dv --verbose=4 "$EXECUTABLE_PATH" 2>&1 || true)"
    if ! echo "$EXECUTABLE_SIGN_INFO" | grep -q "Identifier=$EXPECTED_BUNDLE_IDENTIFIER"; then
      echo "ERROR: Executable identifier mismatch for $EXECUTABLE_PATH. Expected $EXPECTED_BUNDLE_IDENTIFIER"
      exit 1
    fi
  done

  if echo "$SIGN_INFO" | grep -q "adhoc"; then
    echo "WARNING: App was signed ad-hoc (no Developer ID). Notarization check skipped."
    echo "         For a Gatekeeper-clean build, sign with a Developer ID Application cert."
  elif echo "$SIGN_INFO" | grep -q "Authority=Developer ID Application"; then
    echo "Developer ID signature present."
    spctl -a -vv --type exec "$APP_BUNDLE"
    xcrun stapler validate "$APP_BUNDLE" 2>/dev/null && echo "Staple ticket validated." || echo "WARNING: No staple ticket (expected if notarization is in progress)."
  else
    echo "WARNING: No signing authority found. App is unsigned."
    echo "         Set SKIP_SIGNATURE_CHECK=1 to suppress this warning."
  fi
else
  echo "[6/7] Signature check skipped (SKIP_SIGNATURE_CHECK=1 or not macOS)"
fi
echo ""

# ── 7. Launch + backend health + liveness check ──────────────────────────────
echo "[7/7] Launching app for backend + liveness check..."
if [[ -n "$MOUNT_POINT" ]]; then
  LAUNCH_APP_DIR="$(mktemp -d /tmp/eliza-smoke-app.XXXXXX)"
  LAUNCH_APP_BUNDLE="$LAUNCH_APP_DIR/$(basename "$APP_BUNDLE")"
  ditto "$APP_BUNDLE" "$LAUNCH_APP_BUNDLE"
  if [[ "$(uname)" == "Darwin" ]]; then
    # Local ad-hoc smoke runs execute the copied bundle directly from /tmp.
    # Preserve the signed bits, but strip provenance/quarantine xattrs so
    # macOS does not kill the unsigned local launcher before Bun starts.
    xattr -dr com.apple.provenance "$LAUNCH_APP_BUNDLE" 2>/dev/null || true
    xattr -dr com.apple.quarantine "$LAUNCH_APP_BUNDLE" 2>/dev/null || true
  fi
else
  LAUNCH_APP_BUNDLE="$APP_BUNDLE"
fi
LAUNCHER_PATH="$LAUNCH_APP_BUNDLE/Contents/MacOS/launcher"
verify_packaged_renderer_assets

kill_stale_processes
init_startup_session

LOG_OFFSET=0
for startup_log_candidate in "${STARTUP_LOG_CANDIDATES[@]}"; do
  if [[ -f "$startup_log_candidate" ]]; then
    STARTUP_LOG="$startup_log_candidate"
    break
  fi
done
if [[ -f "$STARTUP_LOG" ]]; then
  LOG_OFFSET="$(wc -c < "$STARTUP_LOG" | tr -d ' ')"
fi

if [[ ! -x "$LAUNCHER_PATH" ]]; then
  echo "ERROR: Packaged launcher not found or not executable: $LAUNCHER_PATH"
  exit 1
fi

launch_packaged_app
if [[ "$OPEN_LAUNCH_ATTEMPTED" == "1" && "${OPEN_LAUNCH_EXIT_CODE:-1}" != "0" ]]; then
  echo "ERROR: open(1) failed to launch the packaged app (exit ${OPEN_LAUNCH_EXIT_CODE})."
  dump_failure_diagnostics "open(1) failed to launch packaged app"
  exit 1
fi
sleep 2

BACKEND_PORT=""
HANDOFF_PID=""
LAUNCHER_EXIT_OBSERVED_AT=""

if [[ -z "$PID" ]]; then
  if [[ "$(uname)" == "Darwin" && "$MAC_LAUNCH_MODE" == "open" ]]; then
    echo "Launcher direct exec is unavailable on this macOS host; falling back to open(1)."
  else
    echo "WARNING: Could not start packaged launcher. App may have exited immediately."
    echo "         Check Console.app or crash logs in ~/Library/Logs/DiagnosticReports/"
  fi
  LAUNCHER_EXIT_OBSERVED_AT="$SECONDS"
elif ! kill -0 "$PID" >/dev/null 2>&1; then
  wait "$PID" || true
  echo "Launcher exited before the first health probe; continuing to wait for packaged app handoff..."
  LAUNCHER_EXIT_OBSERVED_AT="$SECONDS"
else
  echo "Launcher is running (PID $PID). Waiting for backend health..."
fi

DEADLINE=$((SECONDS + STARTUP_TIMEOUT))
while [[ $SECONDS -lt $DEADLINE ]]; do
  LIVE_PID="$(find_live_packaged_pid)"
  load_startup_state || true

  if [[ -n "$STATE_PID" && "$STATE_PID" != "$PID" && "$STATE_PID" != "$HANDOFF_PID" ]]; then
    echo "Launcher handoff detected; following packaged app process $STATE_PID."
    HANDOFF_PID="$STATE_PID"
  fi

  if [[ -n "$STATE_PORT" ]]; then
    BACKEND_PORT="$STATE_PORT"
  fi

  if [[ "$STATE_PHASE" == "fatal" ]]; then
    echo "ERROR: Packaged startup entered fatal phase."
    dump_failure_diagnostics "startup trace recorded fatal phase"
    exit 1
  fi

  if [[ -n "$LIVE_PID" ]] && kill -0 "$LIVE_PID" >/dev/null 2>&1; then
    if [[ "$LIVE_PID" != "$PID" && "$LIVE_PID" != "$HANDOFF_PID" ]]; then
      echo "Launcher handoff detected; following packaged app process $LIVE_PID."
      HANDOFF_PID="$LIVE_PID"
    fi
  fi

  if ! kill -0 "$PID" >/dev/null 2>&1 && [[ -z "$BACKEND_PORT" ]]; then
    if [[ -z "$LAUNCHER_EXIT_OBSERVED_AT" ]]; then
      LAUNCHER_EXIT_OBSERVED_AT="$SECONDS"
      echo "Launcher exited; waiting for packaged app handoff..."
    fi

    if [[ -z "$LIVE_PID" ]]; then
      HANDOFF_WAITED=$((SECONDS - LAUNCHER_EXIT_OBSERVED_AT))
      if [[ "$HANDOFF_WAITED" -ge "$PACKAGED_HANDOFF_GRACE_SECONDS" ]]; then
        echo "WARNING: No packaged app process detected within ${PACKAGED_HANDOFF_GRACE_SECONDS}s; continuing to wait for backend startup."
        LAUNCHER_EXIT_OBSERVED_AT="$SECONDS"
      fi
    fi
  fi

  if [[ "$STATE_PHASE" == "runtime_ready" || "$STATE_PHASE" == "metadata_ready" ]]; then
    if [[ -z "$BACKEND_PORT" ]]; then
      echo "ERROR: Startup trace reached $STATE_PHASE without a backend port."
      dump_failure_diagnostics "startup trace missing backend port"
      exit 1
    fi
    if backend_health_probe_satisfied "http://127.0.0.1:${BACKEND_PORT}/api/health"; then
      echo "Backend health check PASSED on port $BACKEND_PORT."
      break
    fi
  fi
  sleep 1
done

if [[ -z "$BACKEND_PORT" ]]; then
  echo "ERROR: Packaged startup never reached runtime_ready with a backend port."
  FAILURE_REASON="startup trace never reached runtime_ready"
  if [[ "$OPEN_LAUNCH_ATTEMPTED" == "1" ]]; then
    FAILURE_REASON="open(1) launch produced no startup trace"
  elif [[ "$(uname)" == "Darwin" && -z "$STATE_PHASE" && "$MAC_DIRECT_EXEC_PROBE_RC" == "137" ]]; then
    FAILURE_REASON="macOS direct app-bundle exec probe returned SIGKILL (137) before startup trace began"
  fi
  dump_failure_diagnostics "$FAILURE_REASON"
  exit 1
fi

if ! backend_health_probe_satisfied "http://127.0.0.1:${BACKEND_PORT}/api/health"; then
  echo "ERROR: Backend did not answer /api/health on port $BACKEND_PORT"
  dump_failure_diagnostics "backend health endpoint never became reachable"
  exit 1
fi

LOG_SLICE="$(tail -c +"$((LOG_OFFSET + 1))" "$STARTUP_LOG" 2>/dev/null || true)"
STREAMING_FAILURE_REGEX='@elizaos/plugin-streaming|@elizaos/plugin-retake'
if printf '%s\n' "$LOG_SLICE" | grep -Eq "Could not load plugin (${STREAMING_FAILURE_REGEX})"; then
  echo "ERROR: Streaming plugin resolution failed during packaged startup."
  printf '%s\n' "$LOG_SLICE" | grep -E "Could not load plugin|Failed plugins:" | tail -n 40
  dump_failure_diagnostics "streaming plugin resolution failed"
  exit 1
fi
if printf '%s\n' "$LOG_SLICE" | grep -Eq "Failed plugins:.*(${STREAMING_FAILURE_REGEX})"; then
  echo "ERROR: Packaged startup reported failed streaming plugins."
  printf '%s\n' "$LOG_SLICE" | grep -E "Plugin resolution complete|Failed plugins:" | tail -n 20
  dump_failure_diagnostics "streaming plugins reported failed"
  exit 1
fi
if printf '%s\n' "$LOG_SLICE" | grep -Eq "AGENT_EVENT service not found on runtime"; then
  echo "ERROR: AGENT_EVENT runtime service was not registered."
  printf '%s\n' "$LOG_SLICE" | grep -E "AGENT_EVENT service not found on runtime|Plugin resolution complete|Failed plugins:" | tail -n 20
  dump_failure_diagnostics "AGENT_EVENT runtime service missing"
  exit 1
fi
echo "Streaming plugin resolution check PASSED."

echo "Waiting ${LIVENESS_TIMEOUT}s for liveness..."
sleep "$LIVENESS_TIMEOUT"
LIVE_PID="$(find_live_packaged_pid)"
if [[ -n "$LIVE_PID" ]] && kill -0 "$LIVE_PID" 2>/dev/null; then
  if backend_health_probe_satisfied "http://127.0.0.1:${BACKEND_PORT}/api/health"; then
    echo "App process ($LIVE_PID) and backend still healthy after ${LIVENESS_TIMEOUT}s — liveness check PASSED."
  else
    echo "ERROR: App stayed open but backend health check failed after ${LIVENESS_TIMEOUT}s."
    dump_failure_diagnostics "backend liveness check failed after startup"
    exit 1
  fi
elif backend_health_probe_satisfied "http://127.0.0.1:${BACKEND_PORT}/api/health"; then
  echo "WARNING: No packaged app process was detected after ${LIVENESS_TIMEOUT}s, but the packaged backend remained healthy."
  echo "         Treating backend liveness as the release gate for this launcher path."
else
  echo "ERROR: No packaged app process remained alive within ${LIVENESS_TIMEOUT}s."
  echo ""
  echo "Launcher stderr:"
  cat "$LAUNCHER_STDERR" 2>/dev/null || true
  dump_failure_diagnostics "packaged app process did not stay alive"
  exit 1
fi

echo ""
echo "============================================================"
echo " Smoke test PASSED"
echo "============================================================"
