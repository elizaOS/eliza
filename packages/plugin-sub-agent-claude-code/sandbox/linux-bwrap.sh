#!/usr/bin/env bash
# Eliza sub-agent Linux bubblewrap wrapper (SOC2 A-3).
#
# Usage: linux-bwrap.sh <workspace_root> <session_id> -- <binary> [args...]
#
# Sets up a per-session jail:
#   - read-only bind: /usr, /lib*, /etc/resolv.conf, /etc/ssl
#   - read-write bind: workspace, /tmp/eliza-sub-agent-<session>, ~/.cache/eliza-sub-agent/<session>
#   - private tmp + dev + proc
#   - new user / pid / ipc / uts / cgroup namespaces
#   - drops all capabilities; new-session for terminal isolation
#
# When bwrap is missing this script exits 127 — callers should detect and
# fall back to env-allowlist-only spawn with a WARN.
set -euo pipefail

if [[ $# -lt 4 ]]; then
  echo "usage: $0 <workspace> <session_id> -- <cmd> [args...]" >&2
  exit 2
fi
workspace="$1"; shift
session="$1"; shift
[[ "$1" == "--" ]] || { echo "missing '--' separator" >&2; exit 2; }
shift

if ! command -v bwrap >/dev/null 2>&1; then
  echo "[sub-agent-sandbox] bwrap not installed; refusing to spawn unsandboxed" >&2
  exit 127
fi

cache_root="${HOME}/.cache/eliza-sub-agent/${session}"
tmp_root="/tmp/eliza-sub-agent-${session}"
mkdir -p "${cache_root}" "${tmp_root}"

# Build a fresh, scoped HOME so the sub-agent cannot reach the spawning
# user's dotfiles. The CLI's needed config bits should be staged into
# ${workspace} before invocation.
exec bwrap \
  --unshare-user --unshare-pid --unshare-ipc --unshare-uts --unshare-cgroup \
  --new-session \
  --die-with-parent \
  --cap-drop ALL \
  --proc /proc --dev /dev \
  --ro-bind /usr /usr \
  --ro-bind /etc/resolv.conf /etc/resolv.conf \
  --ro-bind /etc/ssl /etc/ssl \
  --ro-bind /lib /lib 2>/dev/null || true \
  --bind "${workspace}" "${workspace}" \
  --bind "${tmp_root}" "${tmp_root}" \
  --bind "${cache_root}" "${cache_root}" \
  --tmpfs /tmp \
  --setenv HOME "${cache_root}" \
  --setenv TMPDIR "${tmp_root}" \
  --chdir "${workspace}" \
  -- "$@"
