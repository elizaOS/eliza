#!/usr/bin/env bash
# Establishes the privileged Linux boundary for an untrusted stability scenario.

set -euo pipefail
export PATH="/usr/sbin:/usr/bin:/sbin:/bin"

die() { echo "[cloud-stability-sandbox] $*" >&2; exit 1; }
require_root() { [ "$(/usr/bin/id -u)" -eq 0 ] || die "must run through sudo -n"; }

SANDBOX_USER=""
SANDBOX_UID=""
SANDBOX_GID=""
SANDBOX_CALLER_UID=""
SANDBOX_CHAIN=""
SANDBOX_OUTPUT_DIR=""
SANDBOX_ROOT=""
SANDBOX_IPV4_CHAIN=0
SANDBOX_IPV4_JUMP=0
SANDBOX_IPV6_CHAIN=0
SANDBOX_IPV6_JUMP=0
SANDBOX_CLEANED=1
SANDBOX_CLEANUP_STATUS=0
declare -a SANDBOX_SEARCH_ACL_PATHS=()
declare -a SANDBOX_SEARCH_ACL_SNAPSHOTS=()

grant_output_search_acls() {
  local current candidate acl_state granted_acl
  local -a ancestors=()
  current="$(/usr/bin/dirname -- "$SANDBOX_OUTPUT_DIR")"
  while true; do
    ancestors+=("$current")
    [ "$current" = "/" ] && break
    current="$(/usr/bin/dirname -- "$current")"
  done
  local index
  for ((index=${#ancestors[@]} - 1; index >= 0; index--)); do
    candidate="${ancestors[$index]}"
    if /usr/bin/setpriv --reuid "$SANDBOX_UID" --regid "$SANDBOX_GID" --clear-groups -- /usr/bin/test -x "$candidate"; then
      continue
    fi
    acl_state="$(/usr/bin/getfacl -cpn "$candidate")" || return 1
    if [ "$(/usr/bin/stat -c %u "$candidate")" != "$SANDBOX_CALLER_UID" ] ||
      /usr/bin/grep -Eq '^(user:[^:]|group:[^:]|mask:)' <<<"$acl_state" ||
      ! /usr/bin/grep -qx 'group::---' <<<"$acl_state" ||
      ! /usr/bin/grep -qx 'other::---' <<<"$acl_state"; then
      echo "[cloud-stability-sandbox] refusing to modify non-private output ancestor: $candidate" >&2
      return 1
    fi
    SANDBOX_SEARCH_ACL_PATHS+=("$candidate")
    SANDBOX_SEARCH_ACL_SNAPSHOTS+=("$acl_state")
    /usr/bin/setfacl -n -m "u:${SANDBOX_UID}:--x,m::--x" "$candidate" || return 1
    granted_acl="$(/usr/bin/getfacl -cpn "$candidate")" || return 1
    /usr/bin/grep -qx "user:${SANDBOX_UID}:--x" <<<"$granted_acl" || return 1
    /usr/bin/grep -qx 'group::---' <<<"$granted_acl" || return 1
    /usr/bin/grep -qx 'mask::--x' <<<"$granted_acl" || return 1
    /usr/bin/grep -qx 'other::---' <<<"$granted_acl" || return 1
    if ! /usr/bin/setpriv --reuid "$SANDBOX_UID" --regid "$SANDBOX_GID" --clear-groups -- /usr/bin/test -x "$candidate"; then
      echo "[cloud-stability-sandbox] output ancestor search ACL was ineffective: $candidate" >&2
      return 1
    fi
  done
}

sandbox_cleanup() {
  [ "$SANDBOX_CLEANED" -eq 0 ] || return "$SANDBOX_CLEANUP_STATUS"
  SANDBOX_CLEANED=1
  set +e
  if [[ "$SANDBOX_UID" =~ ^[1-9][0-9]*$ ]]; then
    /usr/bin/pkill -KILL -u "$SANDBOX_UID" 2>/dev/null
    for _ in $(/usr/bin/seq 1 100); do
      /usr/bin/pgrep -u "$SANDBOX_UID" >/dev/null 2>&1 || break
      /bin/sleep 0.02
    done
    if /usr/bin/pgrep -u "$SANDBOX_UID" >/dev/null 2>&1; then
      echo "[cloud-stability-sandbox] sandbox UID retained a process" >&2
      SANDBOX_CLEANUP_STATUS=1
    fi
  fi
  if [ "$SANDBOX_IPV4_JUMP" -eq 1 ] && ! /usr/sbin/iptables -w 5 -D OUTPUT -m owner --uid-owner "$SANDBOX_UID" -j "$SANDBOX_CHAIN"; then SANDBOX_CLEANUP_STATUS=1; fi
  if [ "$SANDBOX_IPV4_CHAIN" -eq 1 ]; then
    /usr/sbin/iptables -w 5 -F "$SANDBOX_CHAIN" 2>/dev/null || SANDBOX_CLEANUP_STATUS=1
    /usr/sbin/iptables -w 5 -X "$SANDBOX_CHAIN" 2>/dev/null || SANDBOX_CLEANUP_STATUS=1
  fi
  if [ "$SANDBOX_IPV6_JUMP" -eq 1 ] && ! /usr/sbin/ip6tables -w 5 -D OUTPUT -m owner --uid-owner "$SANDBOX_UID" -j "$SANDBOX_CHAIN"; then SANDBOX_CLEANUP_STATUS=1; fi
  if [ "$SANDBOX_IPV6_CHAIN" -eq 1 ]; then
    /usr/sbin/ip6tables -w 5 -F "$SANDBOX_CHAIN" 2>/dev/null || SANDBOX_CLEANUP_STATUS=1
    /usr/sbin/ip6tables -w 5 -X "$SANDBOX_CHAIN" 2>/dev/null || SANDBOX_CLEANUP_STATUS=1
  fi
  if [ -n "$SANDBOX_OUTPUT_DIR" ]; then
    local acl_state=""
    /usr/bin/setfacl -R -x "u:${SANDBOX_UID}" "$SANDBOX_OUTPUT_DIR" 2>/dev/null
    /usr/bin/find "$SANDBOX_OUTPUT_DIR" -type d -exec /usr/bin/setfacl -x "d:u:${SANDBOX_UID}" {} + 2>/dev/null
    if ! acl_state="$(/usr/bin/getfacl -R -p "$SANDBOX_OUTPUT_DIR" 2>/dev/null)"; then
      SANDBOX_CLEANUP_STATUS=1
    elif /usr/bin/grep -Eq "^(default:)?user:${SANDBOX_UID}:" <<<"$acl_state"; then
      SANDBOX_CLEANUP_STATUS=1
    fi
  fi
  local acl_index restored_acl
  for ((acl_index=${#SANDBOX_SEARCH_ACL_PATHS[@]} - 1; acl_index >= 0; acl_index--)); do
    if ! /usr/bin/printf '%s\n' "${SANDBOX_SEARCH_ACL_SNAPSHOTS[$acl_index]}" | /usr/bin/setfacl --set-file=- "${SANDBOX_SEARCH_ACL_PATHS[$acl_index]}"; then
      SANDBOX_CLEANUP_STATUS=1
      continue
    fi
    if ! restored_acl="$(/usr/bin/getfacl -cpn "${SANDBOX_SEARCH_ACL_PATHS[$acl_index]}" 2>/dev/null)" || [ "$restored_acl" != "${SANDBOX_SEARCH_ACL_SNAPSHOTS[$acl_index]}" ]; then
      SANDBOX_CLEANUP_STATUS=1
    fi
  done
  if [ -n "$SANDBOX_USER" ]; then /usr/sbin/userdel "$SANDBOX_USER" 2>/dev/null || SANDBOX_CLEANUP_STATUS=1; fi
  if [[ "$SANDBOX_ROOT" = /var/tmp/eliza-stability-sandbox.* ]]; then /bin/rm -rf -- "$SANDBOX_ROOT" || SANDBOX_CLEANUP_STATUS=1; fi
  return "$SANDBOX_CLEANUP_STATUS"
}

setup() {
  require_root
  [ "$(/usr/bin/uname -m)" = "x86_64" ] || die "seccomp policy requires x86_64"
  for command in bwrap getfacl grep iptables ip6tables iptables-save ip6tables-save prlimit setfacl setpriv useradd userdel pkill pgrep python3; do
    command -v "$command" >/dev/null 2>&1 || die "missing required command: $command"
  done
  printf 'ready\n'
}

run() {
  require_root
  [ "$#" -ge 7 ] || die "run requires ports, paths, caller identity, environment, and command"
  local allowed_ports="$1" repo_root="$2" output_dir="$3" caller_home="$4" caller_uid="$5" environment_file="$6"
  shift 6
  [[ "$allowed_ports" =~ ^[0-9]+(,[0-9]+)*$ ]] || die "allowed ports must be numeric"
  [[ "$caller_uid" =~ ^[1-9][0-9]*$ ]] || die "caller UID must be non-root"
  [[ "$repo_root" = /* && "$output_dir" = /* ]] || die "repository and output must be absolute"
  [ "$output_dir" != "/" ] || die "output directory cannot be root"
  [ -d "$repo_root" ] && [ -d "$output_dir" ] || die "repository or output directory is absent"
  [ -x "$1" ] || die "scenario runtime is not executable"
  [ -f "$environment_file" ] && [ ! -L "$environment_file" ] || die "sandbox environment is not a regular file"
  [ "$(/usr/bin/stat -c %a "$environment_file")" = "600" ] || die "sandbox environment mode must be 0600"
  [ "$(/usr/bin/stat -c %u "$environment_file")" = "$caller_uid" ] || die "sandbox environment owner mismatch"
  local environment_real output_real
  environment_real="$(/usr/bin/readlink -f "$environment_file")"
  output_real="$(/usr/bin/readlink -f "$output_dir")"
  [ "$output_dir" = "$output_real" ] && [ ! -L "$output_dir" ] || die "output directory must be a canonical non-symlink path"
  [ "$(/usr/bin/stat -c %u "$output_dir")" = "$caller_uid" ] || die "output directory owner mismatch"
  [[ "$environment_real" = "$output_real"/.sandbox-environment-*.bin ]] || die "sandbox environment escaped output directory"

  local -a child_environment=()
  local entry name
  while IFS= read -r -d '' entry; do
    [[ "$entry" =~ ^[A-Z_][A-Z0-9_]*= ]] || die "invalid sandbox environment record"
    name="${entry%%=*}"
    case "$name" in BASH_ENV|ENV|HOME|LD_*|LOGNAME|PATH|SHELLOPTS|USER) die "forbidden sandbox environment name: $name" ;; esac
    child_environment+=("$entry")
  done < "$environment_file"
  /bin/rm -f -- "$environment_file"

  local sandbox_user="eliza-sbx-${$}-${RANDOM}"
  sandbox_user="${sandbox_user:0:31}"
  /usr/sbin/useradd --system --no-create-home --shell /usr/sbin/nologin "$sandbox_user"
  local uid
  uid="$(/usr/bin/id -u "$sandbox_user")"
  local gid
  gid="$(/usr/bin/id -g "$sandbox_user")"
  [ "$uid" -ne 0 ] || die "sandbox user resolved to root"
  if /usr/bin/pgrep -u "$uid" >/dev/null 2>&1; then
    /usr/sbin/userdel "$sandbox_user" 2>/dev/null
    die "fresh sandbox UID already owns a process"
  fi

  local chain="ELIZA_SBX_${$}_$RANDOM" sandbox_root=""
  chain="${chain:0:27}"
  SANDBOX_USER="$sandbox_user"
  SANDBOX_UID="$uid"
  SANDBOX_GID="$gid"
  SANDBOX_CALLER_UID="$caller_uid"
  SANDBOX_CHAIN="$chain"
  SANDBOX_OUTPUT_DIR="$output_dir"
  SANDBOX_CLEANED=0
  trap sandbox_cleanup EXIT INT TERM HUP

  /usr/sbin/iptables -w 5 -N "$chain"
  SANDBOX_IPV4_CHAIN=1
  /usr/sbin/iptables -w 5 -A "$chain" -o lo -d 127.0.0.0/8 -p tcp -m multiport --dports "$allowed_ports" -j ACCEPT
  /usr/sbin/iptables -w 5 -A "$chain" -j REJECT --reject-with icmp-port-unreachable
  /usr/sbin/iptables -w 5 -I OUTPUT 1 -m owner --uid-owner "$uid" -j "$chain"
  SANDBOX_IPV4_JUMP=1
  /usr/sbin/ip6tables -w 5 -N "$chain"
  SANDBOX_IPV6_CHAIN=1
  /usr/sbin/ip6tables -w 5 -A "$chain" -j REJECT --reject-with icmp6-port-unreachable
  /usr/sbin/ip6tables -w 5 -I OUTPUT 1 -m owner --uid-owner "$uid" -j "$chain"
  SANDBOX_IPV6_JUMP=1

  /usr/bin/setfacl -m "u:${uid}:rwx" -m "d:u:${uid}:rwx" -m "d:u:${caller_uid}:rwx" "$output_dir"
  grant_output_search_acls
  sandbox_root="$(/usr/bin/mktemp -d /var/tmp/eliza-stability-sandbox.XXXXXX)"
  SANDBOX_ROOT="$sandbox_root"
  /bin/chown "$uid:$gid" "$sandbox_root"
  /bin/chmod 0700 "$sandbox_root"
  local runtime="$1"
  shift
  /usr/bin/install -m 0555 "$runtime" "$sandbox_root/runtime"
  /usr/bin/python3 - "$sandbox_root/socket-domain.bpf" <<'PY'
import struct
import sys
filters = [
    (0x20, 0, 0, 4), (0x15, 1, 0, 0xC000003E), (0x06, 0, 0, 0x80000000),
    (0x20, 0, 0, 0), (0x45, 9, 0, 0x40000000), (0x15, 5, 0, 41), (0x15, 7, 0, 53),
    (0x15, 6, 0, 425), (0x15, 5, 0, 426), (0x15, 4, 0, 427),
    (0x06, 0, 0, 0x7FFF0000), (0x20, 0, 0, 16), (0x15, 2, 0, 2),
    (0x15, 1, 0, 10), (0x06, 0, 0, 0x00050001), (0x06, 0, 0, 0x7FFF0000),
]
with open(sys.argv[1], "wb") as output:
    for item in filters:
        output.write(struct.pack("HBBI", *item))
PY
  /bin/chmod 0400 "$sandbox_root/socket-domain.bpf"

  local -a masks=()
  local candidate
  for candidate in "$repo_root/.git" "$caller_home/.gitconfig" "$caller_home/.npmrc" "$caller_home/.config/gh" "$caller_home/.ssh" "$caller_home/.docker"; do
    [ -n "$candidate" ] || continue
    if [ -d "$candidate" ]; then masks+=(--tmpfs "$candidate"); fi
    if [ -f "$candidate" ]; then masks+=(--ro-bind /dev/null "$candidate"); fi
  done

  local execution_status cleanup_status
  set +e
  /usr/bin/prlimit --nproc=512 --nofile=1024 --fsize=1073741824 --cpu=240 -- \
    /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin "${child_environment[@]}" \
      /usr/bin/setpriv --reuid "$uid" --regid "$gid" --clear-groups -- \
      /usr/bin/bwrap --die-with-parent --new-session --unshare-user --unshare-pid --unshare-ipc --unshare-uts \
        --ro-bind / / --tmpfs /run --chmod 0700 /run \
        --tmpfs /tmp --chmod 1777 /tmp --tmpfs /var/tmp --chmod 1777 /var/tmp \
        --dir "$output_dir" --bind "$output_dir" "$output_dir" \
        --dir "$sandbox_root" --bind "$sandbox_root" "$sandbox_root" \
        "${masks[@]}" --proc /proc --dev /dev --chdir "$repo_root" --setenv HOME "$sandbox_root" \
        --setenv ELIZA_STABILITY_SANDBOX_HOST_UID "$uid" \
        --uid 0 --gid 0 --cap-drop ALL --seccomp 3 \
        "$sandbox_root/runtime" "$@" 3<"$sandbox_root/socket-domain.bpf"
  execution_status=$?
  sandbox_cleanup
  cleanup_status=$?
  trap - EXIT INT TERM HUP
  set -e
  if [ "$cleanup_status" -ne 0 ]; then return "$cleanup_status"; fi
  return "$execution_status"
}

case "${1:-}" in
  setup) shift; setup "$@" ;;
  run) shift; run "$@" ;;
  *) die "usage: $0 setup | run PORTS REPO OUTPUT CALLER_HOME CALLER_UID ENV COMMAND [ARG ...]" ;;
esac
