#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '%s\n' "operator-key install failed" >&2
  exit 1
}

[ -n "${OPERATOR_KEY_BASE64:-}" ] || fail
operator_key="$(printf '%s' "$OPERATOR_KEY_BASE64" | openssl base64 -d -A 2>/dev/null)" || fail
[ -n "$operator_key" ] || fail

ssh_dir="$HOME/.ssh"
authorized_keys="$ssh_dir/authorized_keys"
if [ -e "$ssh_dir" ] || [ -L "$ssh_dir" ]; then
  [ -d "$ssh_dir" ] && [ ! -L "$ssh_dir" ] || fail
  ssh_dir_owner="$(stat -c '%u' "$ssh_dir" 2>/dev/null || stat -f '%u' "$ssh_dir" 2>/dev/null)" || fail
  [ "$ssh_dir_owner" = "$(id -u)" ] || fail
else
  umask 077
  mkdir "$ssh_dir"
fi
chmod 0700 "$ssh_dir"

lock_dir="$ssh_dir/.authorized_keys.lock"
lock_acquired=false
for _ in $(seq 1 100); do
  if mkdir "$lock_dir" 2>/dev/null; then
    lock_acquired=true
    break
  fi
  sleep 0.1
done
[ "$lock_acquired" = true ] || fail
cleanup() {
  rmdir "$lock_dir" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

if [ ! -e "$authorized_keys" ] && [ ! -L "$authorized_keys" ]; then
  # noclobber makes creation fail rather than follow or replace a path supplied
  # by a non-cooperating writer between the absence check and open.
  (umask 077; set -C; : > "$authorized_keys") 2>/dev/null || true
fi

[ -f "$authorized_keys" ] && [ ! -L "$authorized_keys" ] || fail
authorized_keys_owner="$(stat -c '%u' "$authorized_keys" 2>/dev/null || stat -f '%u' "$authorized_keys" 2>/dev/null)" || fail
[ "$authorized_keys_owner" = "$(id -u)" ] || fail
chmod 0600 "$authorized_keys"
if grep -qxF -- "$operator_key" "$authorized_keys"; then
  exit 0
fi

[ -f "$authorized_keys" ] && [ ! -L "$authorized_keys" ] || fail
authorized_keys_owner="$(stat -c '%u' "$authorized_keys" 2>/dev/null || stat -f '%u' "$authorized_keys" 2>/dev/null)" || fail
[ "$authorized_keys_owner" = "$(id -u)" ] || fail

# One short O_APPEND write preserves lines added by writers that do not honor
# this installer's lock; replacing a stale snapshot could silently erase them.
if [ -s "$authorized_keys" ] && [ -n "$(tail -c 1 -- "$authorized_keys")" ]; then
  printf '\n%s\n' "$operator_key" >> "$authorized_keys"
else
  printf '%s\n' "$operator_key" >> "$authorized_keys"
fi
rmdir "$lock_dir" || fail
trap - EXIT HUP INT TERM
[ -f "$authorized_keys" ] && [ ! -L "$authorized_keys" ] || fail
authorized_keys_owner="$(stat -c '%u' "$authorized_keys" 2>/dev/null || stat -f '%u' "$authorized_keys" 2>/dev/null)" || fail
[ "$authorized_keys_owner" = "$(id -u)" ] || fail
grep -qxF -- "$operator_key" "$authorized_keys" || fail
