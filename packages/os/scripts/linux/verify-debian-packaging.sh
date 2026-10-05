#!/usr/bin/env bash
# Validate Debian package metadata and user-session activation policy.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."
packaging=linux/packaging/debian
dpkg-parsechangelog -l "$packaging/changelog" >/dev/null
grep -qx 'Architecture: any' "$packaging/control"
grep -Fq '${shlibs:Depends}' "$packaging/control"
grep -Fq 'payload/bin/eliza-desktop' "$packaging/rules"
grep -Fq 'readelf -h' "$packaging/rules"
test -s linux/elizaos/assets/logo_blue_nobg.svg
desktop-file-validate "$packaging/ai.elizaos.app.desktop"
appstreamcli validate --no-net "$packaging/ai.elizaos.app.metainfo.xml"
for executable in eliza-agent eliza-desktop eliza-doctor eliza-autostart; do
  test -x "$packaging/$executable"
  sh -n "$packaging/$executable"
done
grep -qx 'disable elizaos-session.target' "$packaging/80-elizaos.preset"
grep -Fq 'WantedBy=graphical-session.target' "$packaging/elizaos-session.target"
grep -Fq 'ConditionFileIsExecutable=' "$packaging/elizaos-agent.service"
grep -Fq 'ConditionFileIsExecutable=' "$packaging/elizaos-desktop.service"
grep -Fq 'PartOf=graphical-session.target elizaos-session.target' "$packaging/elizaos-agent.service"
grep -Fq 'PartOf=graphical-session.target elizaos-session.target' "$packaging/elizaos-desktop.service"
if grep -R -F 'ConditionPathIsExecutable=' "$packaging"; then
  echo "::error::ConditionPathIsExecutable is not a systemd directive"
  exit 1
fi
grep -Fq 'ELIZAOS_AUTOSTART_OWNER_REQUIRED' "$packaging/eliza-autostart"
grep -Fq 'ELIZAOS_AUTOSTART_SESSION_UNAVAILABLE' "$packaging/eliza-autostart"
grep -Fq 'dh_installsystemduser --no-enable' "$packaging/rules"
