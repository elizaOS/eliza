#!/usr/bin/env bash
# Establishes the privileged Linux boundary for an untrusted stability scenario.

set -euo pipefail

readonly sandbox_user="eliza-stability-sandbox"

die() {
  echo "[cloud-stability-sandbox] $*" >&2
  exit 1
}

require_root() {
  [ "$(id -u)" -eq 0 ] || die "must run through sudo -n"
}

setup() {
  require_root
  for command in bwrap iptables ip6tables prlimit setfacl setpriv useradd; do
    command -v "$command" >/dev/null 2>&1 || die "missing required command: $command"
  done
  if ! id -u "$sandbox_user" >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin "$sandbox_user"
  fi
  local uid
  uid="$(id -u "$sandbox_user")"
  [ "$uid" -ne 0 ] || die "sandbox user resolved to root"
  printf '%s\n' "$uid"
}

run() {
  require_root
  [ "$#" -ge 5 ] || die "run requires UID, allowed ports, repository, output directory, and command"
  local uid="$1"
  local allowed_ports="$2"
  local repo_root="$3"
  local output_dir="$4"
  shift 4

  [ "$uid" = "$(id -u "$sandbox_user")" ] || die "sandbox UID does not match $sandbox_user"
  [[ "$allowed_ports" =~ ^[0-9]+(,[0-9]+)*$ ]] || die "allowed ports must be a comma-separated numeric list"
  [ -d "$repo_root" ] || die "repository root is not a directory"
  [ -d "$output_dir" ] || die "output directory is not a directory"
  [ -x "$1" ] || die "scenario runtime is not executable"

  local chain="ELIZA_SBX_${$}_$RANDOM"
  chain="${chain:0:27}"
  local ipv4_jump=0
  local ipv6_jump=0
  local sandbox_root=""
  cleanup() {
    set +e
    if [ "$ipv4_jump" -eq 1 ]; then iptables -w 5 -D OUTPUT -m owner --uid-owner "$uid" -j "$chain"; fi
    iptables -w 5 -F "$chain" 2>/dev/null
    iptables -w 5 -X "$chain" 2>/dev/null
    if [ "$ipv6_jump" -eq 1 ]; then ip6tables -w 5 -D OUTPUT -m owner --uid-owner "$uid" -j "$chain"; fi
    ip6tables -w 5 -F "$chain" 2>/dev/null
    ip6tables -w 5 -X "$chain" 2>/dev/null
    if [[ "$sandbox_root" = /var/tmp/eliza-stability-sandbox.* ]]; then
      rm -rf -- "$sandbox_root"
    fi
  }
  trap cleanup EXIT INT TERM HUP

  iptables -w 5 -N "$chain"
  iptables -w 5 -A "$chain" -o lo -d 127.0.0.0/8 -p tcp -m multiport --dports "$allowed_ports" -j ACCEPT
  iptables -w 5 -A "$chain" -j REJECT --reject-with icmp-port-unreachable
  iptables -w 5 -I OUTPUT 1 -m owner --uid-owner "$uid" -j "$chain"
  ipv4_jump=1

  ip6tables -w 5 -N "$chain"
  ip6tables -w 5 -A "$chain" -j REJECT --reject-with icmp6-port-unreachable
  ip6tables -w 5 -I OUTPUT 1 -m owner --uid-owner "$uid" -j "$chain"
  ipv6_jump=1

  setfacl -m "u:${uid}:rwx" -m "d:u:${uid}:rwx" "$output_dir"
  sandbox_root="$(mktemp -d /var/tmp/eliza-stability-sandbox.XXXXXX)"
  chown "$uid:$uid" "$sandbox_root"
  chmod 0700 "$sandbox_root"

  local runtime="$1"
  shift
  install -m 0555 "$runtime" "$sandbox_root/runtime"

  local -a masks=()
  local candidate
  local caller_home=""
  if [ -n "${SUDO_USER:-}" ]; then
    caller_home="$(getent passwd "$SUDO_USER" | cut -d: -f6)"
  fi
  for candidate in \
    "$repo_root/.git" \
    "$caller_home/.gitconfig" \
    "$caller_home/.npmrc" \
    "$caller_home/.config/gh" \
    "$caller_home/.ssh" \
    "$caller_home/.docker"; do
    [ -n "$candidate" ] || continue
    if [ -d "$candidate" ]; then masks+=(--tmpfs "$candidate"); fi
    if [ -f "$candidate" ]; then masks+=(--ro-bind /dev/null "$candidate"); fi
  done

  # The namespace exposes a fresh /proc containing only sandbox descendants.
  # The repository is read-only and only the attempt output directory is writable.
  prlimit --nproc=512 --nofile=1024 --fsize=1073741824 --cpu=240 -- \
    bwrap \
      --die-with-parent \
      --new-session \
      --unshare-pid \
      --unshare-ipc \
      --unshare-uts \
      --ro-bind / / \
      --bind "$output_dir" "$output_dir" \
      --bind "$sandbox_root" "$sandbox_root" \
      "${masks[@]}" \
      --proc /proc \
      --dev /dev \
      --chdir "$repo_root" \
      --setenv HOME "$sandbox_root" \
      --uid "$uid" \
      --gid "$uid" \
      --cap-drop ALL \
      "$sandbox_root/runtime" "$@"
}

case "${1:-}" in
  setup)
    shift
    setup "$@"
    ;;
  run)
    shift
    run "$@"
    ;;
  *) die "usage: $0 setup | run UID PORTS REPO OUTPUT COMMAND [ARG ...]" ;;
esac
