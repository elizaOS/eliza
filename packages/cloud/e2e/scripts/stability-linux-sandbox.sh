#!/usr/bin/env bash
# Establishes the privileged Linux boundary for an untrusted stability scenario.

# The trusted caller supplies a minimal environment without BASH_ENV.
# Descriptor inspection is mandatory even when all standard streams are closed.
if [[ ! -d /proc/self/fd || ! -r /proc/self/fd || ! -x /proc/self/fd ]]; then
  exit 1
fi

# CPython may diagnose invalid streams before its helper starts. Never expose a
# socket standard stream to interpreter initialization or any setup diagnostics.
if [[ -S /proc/self/fd/0 || -S /proc/self/fd/1 || -S /proc/self/fd/2 ]]; then
  exit 1
fi

set -euo pipefail
export PATH="/usr/sbin:/usr/bin:/sbin:/bin"

die() { echo "[cloud-stability-sandbox] $*" >&2; exit 1; }
require_root() { [ "$(/usr/bin/id -u)" -eq 0 ] || die "must run through sudo -n"; }

OWNER_DIRECTORY=""
OWNER_HELPER="$(/usr/bin/dirname -- "$(/usr/bin/readlink -f -- "$0")")/stability-sandbox-owner.py"
SANDBOX_USER=""
SANDBOX_UID=""
SANDBOX_GID=""
SANDBOX_CHILD_PID=""
SANDBOX_CALLER_UID=""
SANDBOX_CHAIN=""
SANDBOX_OUTPUT_DIR=""
SANDBOX_OUTPUT_ACL_SNAPSHOT=""
SANDBOX_OUTPUT_ACL_CAPTURED=0
SANDBOX_ROOT=""
SANDBOX_IPV4_CHAIN=0
SANDBOX_IPV4_JUMP=0
SANDBOX_IPV6_CHAIN=0
SANDBOX_IPV6_JUMP=0
SANDBOX_CLEANED=1
SANDBOX_CLEANUP_STATUS=0
declare -a SANDBOX_SEARCH_ACL_PATHS=()
declare -a SANDBOX_SEARCH_ACL_SNAPSHOTS=()

owner_checkpoint() {
  [ -n "$OWNER_DIRECTORY" ] || die "resource effects require a guardian journal"
  {
    declare -p SANDBOX_USER SANDBOX_UID SANDBOX_GID SANDBOX_CHILD_PID SANDBOX_CALLER_UID SANDBOX_CHAIN
    declare -p SANDBOX_OUTPUT_DIR SANDBOX_OUTPUT_ACL_SNAPSHOT SANDBOX_OUTPUT_ACL_CAPTURED SANDBOX_ROOT
    declare -p SANDBOX_IPV4_CHAIN SANDBOX_IPV4_JUMP SANDBOX_IPV6_CHAIN SANDBOX_IPV6_JUMP
    declare -p SANDBOX_CLEANED SANDBOX_CLEANUP_STATUS SANDBOX_SEARCH_ACL_PATHS SANDBOX_SEARCH_ACL_SNAPSHOTS
  } | /usr/bin/python3 -I -S "$OWNER_HELPER" checkpoint "$OWNER_DIRECTORY"
}

cleanup_owned_firewall() {
  local tool="$1" save="$2" rules
  [ -n "$SANDBOX_CHAIN" ] || return 0
  rules="$("$save")" || return 1
  if /usr/bin/grep -Fqx -- "-A OUTPUT -m owner --uid-owner $SANDBOX_UID -j $SANDBOX_CHAIN" <<<"$rules"; then
    "$tool" -w 5 -D OUTPUT -m owner --uid-owner "$SANDBOX_UID" -j "$SANDBOX_CHAIN" || return 1
  fi
  if /usr/bin/grep -Fq -- ":$SANDBOX_CHAIN " <<<"$rules"; then
    "$tool" -w 5 -F "$SANDBOX_CHAIN" || return 1
    "$tool" -w 5 -X "$SANDBOX_CHAIN" || return 1
  fi
  rules="$("$save")" || return 1
  if /usr/bin/grep -Eq -- "(^:$SANDBOX_CHAIN |^-A .* -j $SANDBOX_CHAIN$)" <<<"$rules"; then return 1; fi
}

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
    owner_checkpoint
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
    if [ -n "$SANDBOX_CHILD_PID" ]; then wait "$SANDBOX_CHILD_PID" 2>/dev/null; fi
    for _ in $(/usr/bin/seq 1 100); do
      /usr/bin/pgrep -u "$SANDBOX_UID" >/dev/null 2>&1 || break
      /bin/sleep 0.02
    done
    if /usr/bin/pgrep -u "$SANDBOX_UID" >/dev/null 2>&1; then
      echo "[cloud-stability-sandbox] sandbox UID retained a process" >&2
      SANDBOX_CLEANUP_STATUS=1
    fi
  fi
  cleanup_owned_firewall /usr/sbin/iptables /usr/sbin/iptables-save || SANDBOX_CLEANUP_STATUS=1
  cleanup_owned_firewall /usr/sbin/ip6tables /usr/sbin/ip6tables-save || SANDBOX_CLEANUP_STATUS=1
  if [ -n "$SANDBOX_OUTPUT_DIR" ]; then
    local acl_state=""
    /usr/bin/setfacl -R -x "u:${SANDBOX_UID}" "$SANDBOX_OUTPUT_DIR" 2>/dev/null
    /usr/bin/find "$SANDBOX_OUTPUT_DIR" -type d -exec /usr/bin/setfacl -x "d:u:${SANDBOX_UID}" {} + 2>/dev/null
    if ! acl_state="$(/usr/bin/getfacl -R -p "$SANDBOX_OUTPUT_DIR" 2>/dev/null)"; then
      SANDBOX_CLEANUP_STATUS=1
    elif /usr/bin/grep -Eq "^(default:)?user:${SANDBOX_UID}:" <<<"$acl_state"; then
      SANDBOX_CLEANUP_STATUS=1
    fi
    if [ "$SANDBOX_OUTPUT_ACL_CAPTURED" -eq 1 ]; then
      # Snapshot replacement does not clear default ACLs that were originally absent.
      /usr/bin/setfacl -k "$SANDBOX_OUTPUT_DIR" || SANDBOX_CLEANUP_STATUS=1
      if ! /usr/bin/printf '%s\n' "$SANDBOX_OUTPUT_ACL_SNAPSHOT" | /usr/bin/setfacl --set-file=- "$SANDBOX_OUTPUT_DIR"; then
        SANDBOX_CLEANUP_STATUS=1
      elif ! acl_state="$(/usr/bin/getfacl -cpn "$SANDBOX_OUTPUT_DIR" 2>/dev/null)" || [ "$acl_state" != "$SANDBOX_OUTPUT_ACL_SNAPSHOT" ]; then
        SANDBOX_CLEANUP_STATUS=1
      fi
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
  if [ -n "$SANDBOX_ROOT" ]; then
    /usr/bin/python3 -I -S "$OWNER_HELPER" remove-root "$OWNER_DIRECTORY" || SANDBOX_CLEANUP_STATUS=1
  fi
  # Only the guardian releases the identity, after output ownership and the
  # remaining filesystem/process authority have been independently verified.
  return "$SANDBOX_CLEANUP_STATUS"
}

setup() {
  require_root
  [ "$(/usr/bin/uname -m)" = "x86_64" ] || die "seccomp policy requires x86_64"
  local command command_path
  for command in systemd-run systemctl groupadd groupdel bwrap getfacl grep iptables ip6tables iptables-save ip6tables-save prlimit setfacl setpriv useradd userdel pkill pgrep python3; do
    command_path="$(command -v "$command")" || die "missing required command: $command"
    [ -f "$command_path" ] && [ -x "$command_path" ] || die "missing required command: $command"
  done
  # Exercise the same privileged path before admitting a scenario. All probe
  # state is disposable and no credential or provider endpoint is involved.
  (
    local probe_dir probe_uid probe_status
    probe_uid="$(/usr/bin/id -u nobody)"
    [ "$probe_uid" -ne 0 ] || die "capability probe owner must be non-root"
    probe_dir="$(/usr/bin/mktemp -d /var/tmp/eliza-stability-capability.XXXXXX)"
    trap '/bin/rm -rf -- "$probe_dir"' EXIT
    /bin/chown "$probe_uid" "$probe_dir"
    /bin/chmod 0700 "$probe_dir"
    /usr/bin/install -m 0600 -o "$probe_uid" /dev/null "$probe_dir/.sandbox-environment-probe.bin"
    if run_probe 9 /usr "$probe_dir" "" "$probe_uid" \
      "$probe_dir/.sandbox-environment-probe.bin" /usr/bin/python3 -c '
import errno, os, socket
assert int(os.environ["ELIZA_STABILITY_SANDBOX_HOST_UID"]) != 0
assert os.getpid() < 10
try:
    socket.socketpair()
except OSError as error:
    assert error.errno == errno.EPERM
else:
    raise AssertionError("seccomp capability unavailable")
' 2>&1 | /bin/cat >&2; then
      exit 0
    else
      probe_status=$?
      echo "[cloud-stability-sandbox] required kernel capability probe failed" >&2
      exit "$probe_status"
    fi
  )
  printf 'ready\n'
}

owner_prepare() {
  require_root
  OWNER_DIRECTORY="$1"
  local preparation_deadline="$2"
  shift 2
  owner_checkpoint
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

  local identity_record sandbox_user uid gid
  identity_record="$(/usr/bin/python3 -I -S "$OWNER_HELPER" allocate-identity "$OWNER_DIRECTORY" "$preparation_deadline")" || die "identity admission failed"
  read -r sandbox_user uid gid <<<"$identity_record"
  [[ "$sandbox_user" =~ ^eliza-sbx-[0-9a-f]{20}$ && "$uid" =~ ^[1-9][0-9]*$ && "$gid" =~ ^[1-9][0-9]*$ ]] || die "identity admission returned invalid fields"

  local owner_nonce="${OWNER_DIRECTORY##*-}"
  local chain="ELIZA_SBX_${owner_nonce:0:16}" sandbox_root=""
  SANDBOX_USER="$sandbox_user"
  SANDBOX_UID="$uid"
  SANDBOX_GID="$gid"
  SANDBOX_CALLER_UID="$caller_uid"
  SANDBOX_CHAIN="$chain"
  SANDBOX_OUTPUT_DIR="$output_dir"
  SANDBOX_CLEANED=0
  owner_checkpoint

  SANDBOX_IPV4_CHAIN=1
  owner_checkpoint
  /usr/sbin/iptables -w 5 -N "$chain"
  /usr/sbin/iptables -w 5 -A "$chain" -o lo -d 127.0.0.0/8 -p tcp -m multiport --dports "$allowed_ports" -j ACCEPT
  /usr/sbin/iptables -w 5 -A "$chain" -j REJECT --reject-with icmp-port-unreachable
  SANDBOX_IPV4_JUMP=1
  owner_checkpoint
  /usr/sbin/iptables -w 5 -I OUTPUT 1 -m owner --uid-owner "$uid" -j "$chain"
  SANDBOX_IPV6_CHAIN=1
  owner_checkpoint
  /usr/sbin/ip6tables -w 5 -N "$chain"
  /usr/sbin/ip6tables -w 5 -A "$chain" -j REJECT --reject-with icmp6-port-unreachable
  SANDBOX_IPV6_JUMP=1
  owner_checkpoint
  /usr/sbin/ip6tables -w 5 -I OUTPUT 1 -m owner --uid-owner "$uid" -j "$chain"

  SANDBOX_OUTPUT_ACL_SNAPSHOT="$(/usr/bin/getfacl -cpn "$output_dir")" || die "failed to snapshot output ACL"
  SANDBOX_OUTPUT_ACL_CAPTURED=1
  owner_checkpoint
  /usr/bin/setfacl -m "u:${uid}:rwx" -m "d:u:${uid}:rwx" -m "d:u:${caller_uid}:rwx" "$output_dir"
  grant_output_search_acls
  sandbox_root="/var/tmp/eliza-stability-sandbox.$owner_nonce"
  SANDBOX_ROOT="$sandbox_root"
  owner_checkpoint
  /usr/bin/python3 -I -S "$OWNER_HELPER" create-root "$OWNER_DIRECTORY"
  /bin/chown "$uid:$gid" "$sandbox_root"
  /bin/chmod 0700 "$sandbox_root"
  local runtime="$1"
  shift
  /usr/bin/install -m 0555 "$runtime" "$sandbox_root/runtime"
  /usr/bin/python3 -I -S "$OWNER_HELPER" write-policy "$sandbox_root/socket-domain.bpf"
  /bin/chmod 0400 "$sandbox_root/socket-domain.bpf"

  local -a masks=() masked_paths=()
  local candidate mask_target masked already_masked
  for candidate in "$repo_root/.git" "$caller_home/.gitconfig" "$caller_home/.npmrc" "$caller_home/.config/gh" "$caller_home/.ssh" "$caller_home/.docker"; do
    [ -n "$candidate" ] || continue
    [ -e "$candidate" ] || continue
    mask_target="$candidate"
    # Mask the nearest reachable ancestor rather than relying on host directory
    # permissions remaining private for the lifetime of the sandbox.
    while ! /usr/bin/setpriv --reuid "$uid" --regid "$gid" --clear-groups -- /usr/bin/test -x "$(/usr/bin/dirname -- "$mask_target")"; do
      mask_target="$(/usr/bin/dirname -- "$mask_target")"
      [ "$mask_target" != "/" ] || die "sandbox UID cannot search the filesystem root"
    done
    already_masked=0
    for masked in "${masked_paths[@]}"; do
      if [[ "$mask_target" = "$masked" || "$mask_target" = "$masked/"* ]]; then already_masked=1; break; fi
    done
    [ "$already_masked" -eq 0 ] || continue
    if [ -d "$mask_target" ]; then masks+=(--tmpfs "$mask_target"); fi
    if [ -f "$mask_target" ]; then masks+=(--ro-bind /dev/null "$mask_target"); fi
    masked_paths+=("$mask_target")
  done

  local descriptor_barrier
  descriptor_barrier="$(/usr/bin/dirname -- "$(/usr/bin/readlink -f -- "$0")")/stability-sandbox-exec.py"
  /usr/bin/python3 -I -S "$OWNER_HELPER" write-execution "$OWNER_DIRECTORY" "$sandbox_root/socket-domain.bpf" \
    /usr/bin/prlimit --nproc=512 --nofile=1024 --fsize=1073741824 --cpu=240 -- \
    /usr/bin/python3 -I -S "$descriptor_barrier" "$sandbox_root/socket-domain.bpf" \
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
        "$sandbox_root/runtime" "$@"
  owner_checkpoint
}

owner_execute() {
  require_root
  exec /usr/bin/python3 -I -S "$OWNER_HELPER" payload-exec "$1"
}

owner_cleanup() {
  require_root
  OWNER_DIRECTORY="$1"
  # Internal guardian entry: cleanup_resources holds the identity lock and
  # regenerates this state from the verified root-only journal before spawning.
  source "$OWNER_DIRECTORY/shell-state"
  sandbox_cleanup || return "$SANDBOX_CLEANUP_STATUS"
  if [ -n "$SANDBOX_OUTPUT_DIR" ] && [ -n "$SANDBOX_UID" ]; then
    /usr/bin/python3 -I -S "$OWNER_HELPER" transfer-output "$OWNER_DIRECTORY" "$SANDBOX_OUTPUT_DIR" "$SANDBOX_CALLER_UID" "$2"
  fi
}

run_probe() {
  local supervisor_pid="$BASHPID" supervisor_identity
  supervisor_identity="$(/usr/bin/python3 -I -S "$OWNER_HELPER" process-identity "$supervisor_pid")"
  /usr/bin/python3 -I -S "$OWNER_HELPER" launcher-probe "$supervisor_identity" "$0" "$@"
}

run() {
  require_root
  [ "$#" -ge 8 ] || die "run requires original supervisor identity and sandbox arguments"
  local supervisor_identity="$1"
  shift
  exec /usr/bin/python3 -I -S "$OWNER_HELPER" launcher "$supervisor_identity" "$0" "$@"
}

run_native() {
  require_root
  [ "$#" -ge 10 ] || die "run-native requires supervisor, native authority, and payload arguments"
  local supervisor_identity="$1" native_bundle="$2" native_request="$3"
  shift 3
  exec /usr/bin/python3 -I -S "$OWNER_HELPER" launcher-native "$supervisor_identity" "$0" "$native_bundle" "$native_request" "$@"
}

case "${1:-}" in
  run-native) shift; run_native "$@" ;;
  setup) shift; setup "$@" ;;
  run) shift; run "$@" ;;
  owner-prepare) shift; owner_prepare "$@" ;;
  owner-execute) shift; owner_execute "$@" ;;
  owner-cleanup) shift; owner_cleanup "$@" ;;
  *) die "usage: $0 setup | run PORTS REPO OUTPUT CALLER_HOME CALLER_UID ENV COMMAND [ARG ...]" ;;
esac
