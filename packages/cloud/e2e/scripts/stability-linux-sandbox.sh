#!/usr/bin/env bash
# Establishes the privileged Linux boundary for an untrusted stability scenario.

set -euo pipefail
export PATH="/usr/sbin:/usr/bin:/sbin:/bin"

die() { echo "[cloud-stability-sandbox] $*" >&2; exit 1; }
require_root() { [ "$(/usr/bin/id -u)" -eq 0 ] || die "must run through sudo -n"; }

setup() {
  require_root
  [ "$(/usr/bin/uname -m)" = "x86_64" ] || die "seccomp policy requires x86_64"
  for command in bwrap iptables ip6tables iptables-save ip6tables-save prlimit setfacl useradd userdel pkill pgrep python3; do
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
  [ -d "$repo_root" ] && [ -d "$output_dir" ] || die "repository or output directory is absent"
  [ -x "$1" ] || die "scenario runtime is not executable"
  [ -f "$environment_file" ] && [ ! -L "$environment_file" ] || die "sandbox environment is not a regular file"
  [ "$(/usr/bin/stat -c %a "$environment_file")" = "600" ] || die "sandbox environment mode must be 0600"
  [ "$(/usr/bin/stat -c %u "$environment_file")" = "$caller_uid" ] || die "sandbox environment owner mismatch"
  local environment_real output_real
  environment_real="$(/usr/bin/readlink -f "$environment_file")"
  output_real="$(/usr/bin/readlink -f "$output_dir")"
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
  [ "$uid" -ne 0 ] || die "sandbox user resolved to root"
  if /usr/bin/pgrep -u "$uid" >/dev/null 2>&1; then
    /usr/sbin/userdel "$sandbox_user" 2>/dev/null
    die "fresh sandbox UID already owns a process"
  fi

  local chain="ELIZA_SBX_${$}_$RANDOM" ipv4_jump=0 ipv6_jump=0 sandbox_root="" cleaned=0 cleanup_status=0
  chain="${chain:0:27}"
  cleanup() {
    [ "$cleaned" -eq 0 ] || return "$cleanup_status"
    cleaned=1
    set +e
    if [ "$ipv4_jump" -eq 1 ]; then /usr/sbin/iptables -w 5 -D OUTPUT -m owner --uid-owner "$uid" -j "$chain"; fi
    /usr/sbin/iptables -w 5 -F "$chain" 2>/dev/null
    /usr/sbin/iptables -w 5 -X "$chain" 2>/dev/null
    if [ "$ipv6_jump" -eq 1 ]; then /usr/sbin/ip6tables -w 5 -D OUTPUT -m owner --uid-owner "$uid" -j "$chain"; fi
    /usr/sbin/ip6tables -w 5 -F "$chain" 2>/dev/null
    /usr/sbin/ip6tables -w 5 -X "$chain" 2>/dev/null
    /usr/bin/pkill -KILL -u "$uid" 2>/dev/null
    for _ in $(/usr/bin/seq 1 100); do
      /usr/bin/pgrep -u "$uid" >/dev/null 2>&1 || break
      /bin/sleep 0.02
    done
    if /usr/bin/pgrep -u "$uid" >/dev/null 2>&1; then
      echo "[cloud-stability-sandbox] sandbox UID retained a process" >&2
      cleanup_status=1
    fi
    /usr/bin/setfacl -R -x "u:${uid}" "$output_dir" 2>/dev/null
    /usr/bin/find "$output_dir" -type d -exec /usr/bin/setfacl -x "d:u:${uid}" {} + 2>/dev/null
    /usr/sbin/userdel "$sandbox_user" 2>/dev/null || cleanup_status=1
    if [[ "$sandbox_root" = /var/tmp/eliza-stability-sandbox.* ]]; then /bin/rm -rf -- "$sandbox_root"; fi
    return "$cleanup_status"
  }
  trap cleanup EXIT INT TERM HUP

  /usr/sbin/iptables -w 5 -N "$chain"
  /usr/sbin/iptables -w 5 -A "$chain" -o lo -d 127.0.0.0/8 -p tcp -m multiport --dports "$allowed_ports" -j ACCEPT
  /usr/sbin/iptables -w 5 -A "$chain" -j REJECT --reject-with icmp-port-unreachable
  /usr/sbin/iptables -w 5 -I OUTPUT 1 -m owner --uid-owner "$uid" -j "$chain"
  ipv4_jump=1
  /usr/sbin/ip6tables -w 5 -N "$chain"
  /usr/sbin/ip6tables -w 5 -A "$chain" -j REJECT --reject-with icmp6-port-unreachable
  /usr/sbin/ip6tables -w 5 -I OUTPUT 1 -m owner --uid-owner "$uid" -j "$chain"
  ipv6_jump=1

  /usr/bin/setfacl -m "u:${uid}:rwx" -m "d:u:${uid}:rwx" -m "d:u:${caller_uid}:rwx" "$output_dir"
  sandbox_root="$(/usr/bin/mktemp -d /var/tmp/eliza-stability-sandbox.XXXXXX)"
  /bin/chown "$uid:$uid" "$sandbox_root"
  /bin/chmod 0700 "$sandbox_root"
  local runtime="$1"
  shift
  /usr/bin/install -m 0555 "$runtime" "$sandbox_root/runtime"
  /usr/bin/python3 - "$sandbox_root/socket-domain.bpf" <<'PY'
import struct
import sys
filters = [
    (0x20, 0, 0, 4), (0x15, 1, 0, 0xC000003E), (0x06, 0, 0, 0x80000000),
    (0x20, 0, 0, 0), (0x15, 0, 4, 41), (0x20, 0, 0, 16),
    (0x15, 2, 0, 2), (0x15, 1, 0, 10), (0x06, 0, 0, 0x00050001),
    (0x06, 0, 0, 0x7FFF0000),
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

  /usr/bin/prlimit --nproc=512 --nofile=1024 --fsize=1073741824 --cpu=240 -- \
    /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin "${child_environment[@]}" \
      /usr/bin/bwrap --die-with-parent --new-session --unshare-pid --unshare-ipc --unshare-uts \
        --ro-bind / / --bind "$output_dir" "$output_dir" --bind "$sandbox_root" "$sandbox_root" \
        "${masks[@]}" --proc /proc --dev /dev --chdir "$repo_root" --setenv HOME "$sandbox_root" \
        --uid "$uid" --gid "$uid" --cap-drop ALL --seccomp 3 \
        "$sandbox_root/runtime" "$@" 3<"$sandbox_root/socket-domain.bpf"
}

case "${1:-}" in
  setup) shift; setup "$@" ;;
  run) shift; run "$@" ;;
  *) die "usage: $0 setup | run PORTS REPO OUTPUT CALLER_HOME CALLER_UID ENV COMMAND [ARG ...]" ;;
esac
