#!/usr/bin/env bash
# Lint pass over the variant tree: yaml, json, shebangs, exec bits, sh.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${HERE}"

fail=0

# JSON files parse.
while IFS= read -r f; do
    python3 -c "import json,sys; json.load(open(sys.argv[1]))" "${f}" \
        || { echo "INVALID JSON: ${f}"; fail=1; }
done < <(find . \
    \( -path "./out" -o -path "./cache" -o -path "./chroot" -o -path "./binary" -o -path "./artifacts" \) -prune \
    -o -name "*.json" -print)

# Hooks must be executable and start with a shebang.
for f in config/hooks/normal/*.hook.chroot; do
    [ -e "${f}" ] || continue
    [ -x "${f}" ] || { echo "NOT EXECUTABLE: ${f}"; fail=1; }
    head -1 "${f}" | grep -q '^#!' || { echo "MISSING SHEBANG: ${f}"; fail=1; }
done

# Shell scripts parse with their declared interpreter. Several harnesses use
# bash arrays/process substitution and are intentionally not POSIX sh.
while IFS= read -r f; do
    first_line="$(head -1 "${f}")"
    if printf '%s\n' "${first_line}" | grep -q 'bash'; then
        bash -n "${f}" 2>/dev/null || { echo "BASH PARSE FAIL: ${f}"; fail=1; }
    else
        sh -n "${f}" 2>/dev/null || { echo "SH PARSE FAIL: ${f}"; fail=1; }
    fi
done < <(find scripts config/includes.chroot/usr/local/lib/elizaos config/includes.chroot/usr/lib/elizaos \
    \( -name "*.sh" -o -name "first-boot.sh" -o -name "start-launcher" -o -name "start-chat-overlay" \) \
    2>/dev/null)

# Release-check Make targets must stay wired to the checked-in Python gate.
# This is intentionally source-only: it catches stale deleted helper paths
# without requiring a local ISO, QEMU transcript, or release artifact.
python3 -c 'import ast,pathlib; ast.parse(pathlib.Path("scripts/check_release_manifest.py").read_text())' \
    || { echo "PY COMPILE FAIL: scripts/check_release_manifest.py"; fail=1; }
[ -s ../../release/schema/elizaos-os-release-manifest.schema.json ] \
    || { echo "MISSING RELEASE SCHEMA: release-check cannot validate manifests"; fail=1; }
[ ! -e manifest.json ] \
    || { echo "STALE RELEASE CLAIM: generated manifests belong in out/, not the source tree"; fail=1; }
if ! make -n release-check ARCH=riscv64 2>/dev/null | grep -q 'scripts/check_release_manifest.py'; then
    echo "BAD RELEASE CHECK TARGET: release-check must invoke scripts/check_release_manifest.py"
    fail=1
fi
if make -n release-check ARCH=riscv64 2>/dev/null | grep -q 'scripts/release-check.sh'; then
    echo "STALE RELEASE CHECK TARGET: release-check references deleted scripts/release-check.sh"
    fail=1
fi

# The image package contract is explicit. live-build's firmware discovery has
# previously pulled unrelated astronomy and telephony packages, plus mutable
# installer packages that download blobs during the build.
grep -q '^FIRMWARE_OPTIONS="--firmware-chroot false --firmware-binary false"$' auto/config \
    || { echo "FIRMWARE DISCOVERY ENABLED: declare firmware explicitly"; fail=1; }
grep -q '^    --cache false \\$' auto/config \
    || { echo "LIVE-BUILD CACHE ENABLED: release builds must not restore stale chroots"; fail=1; }
grep -q '"${HERE}/binary" "${HERE}/cache" "${HERE}/chroot"' build.sh \
    || { echo "STALE CACHE RETENTION: build.sh must remove the live-build cache"; fail=1; }
if grep -q 'apt-cacher-ng' Dockerfile; then
    echo "UNWIRED BUILD CACHE: apt-cacher-ng must not be installed when caching is disabled"
    fail=1
fi
python3 - <<'PY' || fail=1
import json
from pathlib import Path
import re

lock = json.loads(Path("app-source.lock.json").read_text(encoding="utf-8"))
assert lock.get("schema") == "eliza.os.linux.app-source-lock.v1"
assert lock.get("repository") == "https://github.com/elizaOS/eliza"
assert re.fullmatch(r"[0-9a-f]{40}", lock.get("commit", ""))
snapshot = json.loads(Path("debian-snapshot.lock.json").read_text(encoding="utf-8"))
assert snapshot.get("schema") == "eliza.os.linux.debian-snapshot-lock.v1"
assert re.fullmatch(r"[0-9]{8}T[0-9]{6}Z", snapshot.get("serial", ""))
assert re.fullmatch(r"debian:trixie@sha256:[0-9a-f]{64}", snapshot.get("baseImage", ""))
for entry in snapshot.get("archives", {}).values():
    assert entry["url"].endswith("/" + snapshot["serial"])
    assert re.fullmatch(r"[0-9a-f]{64}", entry["releaseSha256"])
template = Path("manifest.amd64.gui.json.template").read_text(encoding="utf-8")
assert '"kind": "iso-hybrid"' in template
assert "@@ELIZA_COMMIT@@" in template
assert "@@APP_ARTIFACT_SHA256@@" in template
assert "@@DEBIAN_SNAPSHOT_SERIAL@@" in template
assert "@@DEBIAN_BASE_IMAGE@@" in template
riscv_template = Path("manifest.json.template").read_text(encoding="utf-8")
assert '"kind": "iso-hybrid"' in riscv_template
assert '"sizeBytes": @@SIZE_BYTES@@' in riscv_template
assert '"id": "riscv64-agent-runtime"' in riscv_template
assert '"status": "collected"' not in riscv_template
PY
grep -q 'packaged app commit .* does not match lock' build.sh \
    || { echo "UNPINNED PACKAGED APP: build.sh must reject an app outside the source lock"; fail=1; }
grep -q 'no release manifest contract for' build.sh \
    || { echo "MANIFEST FALLBACK: unsupported targets must fail before image assembly"; fail=1; }
grep -q 'snapshot Release digest mismatch' build.sh \
    || { echo "UNVERIFIED SNAPSHOT: build.sh must hash both Release files"; fail=1; }
grep -q '^FROM \${DEBIAN_BASE_IMAGE}$' Dockerfile \
    || { echo "FLOATING BUILDER BASE: Dockerfile must consume the digest-pinned lock"; fail=1; }
if grep -R -E -n '^(indi-dsi|dahdi-firmware-nonfree|firmware-b43-installer|firmware-b43legacy-installer)$' config/package-lists config/profiles 2>/dev/null; then
    echo "UNBOUNDED FIRMWARE PACKAGE: remove unrelated or mutable installer package"
    fail=1
fi
if grep -R -E -n '^pulseaudio$' config/package-lists config/profiles 2>/dev/null; then
    echo "CONFLICTING AUDIO DAEMON: use pipewire-pulse plus pulseaudio-utils"
    fail=1
fi
grep -q '^openssh-server$' config/package-lists/elizaos-common.list.chroot \
    || { echo "UNWIRED QEMU SSH: common image must install openssh-server"; fail=1; }
capability_runner=config/includes.chroot/usr/local/lib/elizaos/capability-runner
admin_mode=config/includes.chroot/etc/elizaos/admin-mode
sudoers_policy=config/includes.chroot/etc/sudoers.d/elizaos-capability-runner
[ "$(cat "${admin_mode}")" = disabled ] \
    || { echo "UNSAFE ADMIN DEFAULT: capability broker must ship disabled"; fail=1; }
if grep -qE '(^|[|[:space:]])exec\)' "${capability_runner}"; then
    echo "ARBITRARY ROOT EXECUTION: capability broker must expose closed operations only"
    fail=1
fi
grep -q 'audit failed; refusing privileged operation' "${capability_runner}" \
    || { echo "FAIL-OPEN AUDIT: privileged operations must stop when logging fails"; fail=1; }
if grep -qF 'capability-runner *' "${sudoers_policy}"; then
    echo "UNBOUNDED SUDO POLICY: enumerate each broker operation"
    fail=1
fi
for operation in root-status service package network power; do
    grep -q "capability-runner ${operation}" "${sudoers_policy}" \
        || { echo "MISSING SUDO OPERATION: ${operation}"; fail=1; }
done
for generated in config/package-lists/elizaos-gui.list.chroot config/package-lists/live.list.chroot; do
    [ ! -e "${generated}" ] || { echo "GENERATED PROFILE LEAK: ${generated}"; fail=1; }
done
if [ -d config/includes.chroot/opt/elizaos-artifacts ] &&
    find config/includes.chroot/opt/elizaos-artifacts -mindepth 1 -print -quit | grep -q .; then
    echo "STALE AGENT ARTIFACTS: generated runtime bytes must not be checked into includes.chroot"
    fail=1
fi
grep -q 'mount freshly staged agent artifacts or a packaged desktop app' build.sh \
    || { echo "UNBOUND AGENT IMAGE: builds must fail without an explicit runtime input"; fail=1; }
[ ! -d mkosi ] || { echo "STALE BUILD PATH: mkosi/ must not coexist with canonical live-build"; fail=1; }

# Systemd unit files have [Unit] + [Install] (or are .path/.target).
for f in $(find config/includes.chroot/etc/systemd -name "*.service" 2>/dev/null); do
    grep -q '^\[Unit\]' "${f}" || { echo "BAD UNIT: ${f}"; fail=1; }
done

if [ "${fail}" -eq 0 ]; then
    echo "OK: static smoke passed"
else
    echo "FAIL: static smoke had errors" >&2
fi
exit "${fail}"
