#!/usr/bin/env bash
# Inspects the built Debian control archive to prove that debhelper, rather
# than a root-owned dpkg process, owns the user-service upgrade state machine.

set -euo pipefail

if [[ "$#" -ne 1 ]] || [[ ! -f "$1" ]]; then
  echo "Usage: verify-maintainer-scripts.sh <elizaos-app.deb>" >&2
  exit 1
fi

deb_path="$(realpath "$1")"
audit_root="$(mktemp -d /tmp/elizaos-deb-control.XXXXXX)"

cleanup() {
  # error-policy:J6 the extracted control archive is disposable audit state.
  rm -rf -- "$audit_root"
}
trap cleanup EXIT

dpkg-deb --control "$deb_path" "$audit_root"
postinst="$audit_root/postinst"
postrm="$audit_root/postrm"
test -f "$postinst"
test -f "$postrm"

grep -Fq 'Automatically added by dh_installsystemduser' "$postinst"
grep -Fq 'Automatically added by dh_installsystemduser' "$postrm"
grep -Fq "deb-systemd-helper --user unmask 'elizaos-app.service'" "$postinst"
grep -Fq "deb-systemd-helper --quiet --user was-enabled 'elizaos-app.service'" "$postinst"
grep -Fq "deb-systemd-helper --user enable 'elizaos-app.service'" "$postinst"
grep -Fq "deb-systemd-helper --user update-state 'elizaos-app.service'" "$postinst"
grep -Fq "deb-systemd-helper --user purge 'elizaos-app.service'" "$postrm"

unmask_line="$(grep -nF "deb-systemd-helper --user unmask 'elizaos-app.service'" "$postinst" | cut -d: -f1)"
was_enabled_line="$(grep -nF "deb-systemd-helper --quiet --user was-enabled 'elizaos-app.service'" "$postinst" | cut -d: -f1)"
enable_line="$(grep -nF "deb-systemd-helper --user enable 'elizaos-app.service'" "$postinst" | cut -d: -f1)"
update_state_line="$(grep -nF "deb-systemd-helper --user update-state 'elizaos-app.service'" "$postinst" | cut -d: -f1)"
((unmask_line < was_enabled_line))
((was_enabled_line < enable_line))
((enable_line < update_state_line))

if grep -R -E \
  '^[[:space:]]*(if[[:space:]]+![[:space:]]+)?systemctl[[:space:]]' \
  "$audit_root"; then
  echo "Debian maintainer scripts must not call systemctl directly" >&2
  exit 1
fi

package_members="$(dpkg-deb --fsys-tarfile "$deb_path" | tar -tf -)"
grep -Fxq './usr/lib/systemd/user/elizaos-app.service' <<< "$package_members"
if grep -Eq '^\./(usr/)?lib/systemd/system/elizaos-app\.service$' \
  <<< "$package_members"; then
  echo "User service was also packaged as a system service" >&2
  exit 1
fi

echo "Verified debhelper-managed user-service install and upgrade state"
