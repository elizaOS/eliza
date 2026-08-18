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
temporary=""
cleanup() {
  if [ -n "$temporary" ] && [ -e "$temporary" ]; then
    rm -f -- "$temporary"
  fi
  rmdir "$lock_dir" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

if [ -e "$authorized_keys" ] || [ -L "$authorized_keys" ]; then
  [ -f "$authorized_keys" ] && [ ! -L "$authorized_keys" ] || fail
  authorized_keys_owner="$(stat -c '%u' "$authorized_keys" 2>/dev/null || stat -f '%u' "$authorized_keys" 2>/dev/null)" || fail
  [ "$authorized_keys_owner" = "$(id -u)" ] || fail
  if grep -qxF -- "$operator_key" "$authorized_keys"; then
    chmod 0600 "$authorized_keys"
    exit 0
  fi
fi

umask 077
temporary="$(mktemp "$ssh_dir/.authorized_keys.XXXXXX")" || fail
if [ -f "$authorized_keys" ]; then
  cat -- "$authorized_keys" > "$temporary"
fi
if [ -s "$temporary" ] && [ -n "$(tail -c 1 -- "$temporary")" ]; then
  printf '\n' >> "$temporary"
fi
printf '%s\n' "$operator_key" >> "$temporary"
chmod 0600 "$temporary"
grep -qxF -- "$operator_key" "$temporary" || fail
mv -f -- "$temporary" "$authorized_keys"
temporary=""
rmdir "$lock_dir" || fail
trap - EXIT HUP INT TERM
grep -qxF -- "$operator_key" "$authorized_keys" || fail
