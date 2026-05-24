#!/usr/bin/env bash
# Cheap security policy checks for the elizaOS Live overlay.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STRICT="${ELIZAOS_SECURITY_STRICT:-0}"
cd "${ROOT}"

failures=0
warnings=0

fail() {
    echo "FAIL: $*" >&2
    failures=$((failures + 1))
}

warn() {
    echo "WARN: $*" >&2
    warnings=$((warnings + 1))
}

strict_or_warn() {
    if [ "${STRICT}" = "1" ]; then
        fail "$@"
    else
        warn "$@"
    fi
}

require_file() {
    if [ ! -f "$1" ]; then
        fail "missing required file: $1"
    fi
}

require_grep() {
    pattern="$1"
    path="$2"
    message="$3"
    if ! grep -Eq "${pattern}" "${path}"; then
        fail "${message}: ${path}"
    fi
}

require_fixed() {
    needle="$1"
    path="$2"
    message="$3"
    if ! grep -Fq "${needle}" "${path}"; then
        fail "${message}: ${path}"
    fi
}

for path in \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/capability-runner \
    tails/config/chroot_local-includes/etc/generate-sudoers.d/elizaos-capability-runner.toml \
    tails/config/chroot_local-includes/usr/lib/python3/dist-packages/tps/configuration/features.py \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/persistence-maintenance \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/runtime-env \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/update-health-check \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/update-manager \
    tails/config/chroot_local-includes/etc/systemd/system/elizaos-update-health-check.service \
    tails/config/chroot_local-includes/etc/systemd/system/elizaos-update-verify.service \
    tails/config/chroot_local-includes/etc/systemd/system/elizaos.service \
    tails/config/chroot_local-includes/etc/systemd/user/elizaos-agent.service \
    tails/config/chroot_local-includes/etc/systemd/user/elizaos-renderer.service \
    tails/config/chroot_local-includes/etc/systemd/user/elizaos.service \
    schemas/update-manifest.schema.json \
    schemas/model-catalog.schema.json
do
    require_file "${path}"
done

echo "==> capability broker boundary"
broker=tails/config/chroot_local-includes/usr/local/lib/elizaos/capability-runner
sudoers=tails/config/chroot_local-includes/etc/generate-sudoers.d/elizaos-capability-runner.toml

require_fixed 'executable = "/usr/local/lib/elizaos/capability-runner"' \
    "${sudoers}" "elizaOS sudoers must target only capability-runner"
require_fixed 'allowed_user = "amnesia"' \
    "${sudoers}" "elizaOS sudoers must be limited to the live user"
require_fixed 'args = ["root-status"]' \
    "${sudoers}" "elizaOS sudoers must allow only the root-status smoke command"

if grep -Eq 'ALL|arbitrary_arguments|NOPASSWD: ALL|/bin/(ba)?sh|apt(-get)?|systemctl|service |nmcli|dd |mkfs|mount |umount ' "${sudoers}"; then
    fail "elizaOS sudoers grants broad or mutating root authority: ${sudoers}"
fi

for command_name in status root-status open-persistent-storage privacy-mode; do
    require_grep "^[[:space:]]*${command_name}\\)" "${broker}" \
        "capability-runner missing command allowlist case ${command_name}"
done

if grep -Eq 'apt(-get)?|dpkg|systemctl|service |nmcli|iptables|nft |dd |mkfs|mount |umount |parted|sgdisk|curl |wget ' "${broker}"; then
    fail "capability-runner exposes broad package, network, service, or disk mutation"
fi
require_fixed 'exec sudo -n "${self}" "$@"' "${broker}" \
    "capability-runner must recurse through the exact sudo allowlist"

echo "==> broad sudoers inventory"
sudoers_review=docs/inherited-tails-sudoers-review.md
require_file "${sudoers_review}"
reviewed_inherited_sudoers=(
    tails/config/chroot_local-includes/etc/generate-sudoers.d/tails-greeter-cryptsetup.toml
    tails/config/chroot_local-includes/etc/generate-sudoers.d/tails-greeter-umount.toml
    tails/config/chroot_local-includes/etc/generate-sudoers.d/tbb.toml
    tails/config/chroot_local-includes/etc/generate-sudoers.d/tps.toml
    tails/config/chroot_local-includes/etc/generate-sudoers.d/upgrade.toml
    tails/config/chroot_local-includes/etc/generate-sudoers.d/whisperback.toml
)

is_reviewed_inherited_sudoers() {
    local candidate="$1"
    local reviewed
    for reviewed in "${reviewed_inherited_sudoers[@]}"; do
        if [ "${candidate}" = "${reviewed}" ]; then
            return 0
        fi
    done
    return 1
}

for reviewed in "${reviewed_inherited_sudoers[@]}"; do
    require_file "${reviewed}"
    require_fixed "$(basename "${reviewed}")" "${sudoers_review}" \
        "inherited sudoers review missing entry"
done

while IFS= read -r file; do
    [ -n "${file}" ] || continue
    case "${file}" in
        *elizaos*)
            fail "unexpected broad elizaOS sudoers rule: ${file}"
            ;;
        *)
            if ! is_reviewed_inherited_sudoers "${file}"; then
                strict_or_warn "unreviewed inherited Tails broad sudoers rule: ${file}"
            fi
            ;;
    esac
done < <(
    rg -l 'executable = "ALL"|NOPASSWD: ALL|arbitrary_arguments]' \
        tails/config/chroot_local-includes/etc/generate-sudoers.d || true
)

echo "==> runtime packaging boundary"
require_file docs/runtime-packaging.md
require_file scripts/prepare-elizaos-app-overlay.mjs
require_file scripts/validate-runtime-overlay.mjs
require_file tails/config/chroot_local-hooks/9100-install-elizaos
require_fixed 'not a post-boot injection path' docs/runtime-packaging.md \
    "runtime packaging docs must reject post-boot injection"
require_fixed 'Resources/app/elizaos-live-overlay-manifest.json' docs/runtime-packaging.md \
    "runtime packaging docs must require the live overlay manifest"
require_fixed 'Production replacement:' docs/runtime-packaging.md \
    "runtime packaging docs must name the production replacement path"
require_fixed 'elizaos-live-overlay-manifest.json' scripts/prepare-elizaos-app-overlay.mjs \
    "runtime prepare step must write an overlay manifest"
require_fixed 'manifest package inventory does not match staged node_modules' \
    scripts/validate-runtime-overlay.mjs \
    "runtime validator must compare package inventory"
require_grep '^src=/usr/share/elizaos/elizaos-app$' \
    tails/config/chroot_local-hooks/9100-install-elizaos \
    "runtime install hook must use the staged live-build app root"
require_grep '^dst=/opt/elizaos$' \
    tails/config/chroot_local-hooks/9100-install-elizaos \
    "runtime install hook must install to the immutable factory runtime root"
if grep -Eq 'curl |wget |git clone|npm install|bun install|pnpm install|yarn install' \
    tails/config/chroot_local-hooks/9100-install-elizaos; then
    fail "runtime install hook must not fetch or resolve dependencies during image build"
fi

echo "==> persistence boundary"
python3 - <<'PY'
from pathlib import Path

path = Path("tails/config/chroot_local-includes/usr/lib/python3/dist-packages/tps/configuration/features.py")
text = path.read_text()

required = {
    'Binding("elizaos/eliza", "/home/amnesia/.eliza")',
    'Binding("elizaos/elizaos", "/home/amnesia/.elizaos")',
    'Binding("elizaos/config", "/home/amnesia/.config/elizaOS")',
    'Binding("elizaos/config-legacy", "/home/amnesia/.config/elizaos")',
    'Binding("elizaos/config-legacy-caps", "/home/amnesia/.config/elizaOS")',
    'Binding("elizaos/cef-cache", "/home/amnesia/.cache/org.elizaos.app")',
    'Binding("elizaos/cef-cache-legacy", "/home/amnesia/.cache/org.elizaos.app")',
    'translatable_name = "elizaOS Data"',
}
missing = sorted(item for item in required if item not in text)
if missing:
    raise SystemExit(f"{path}: missing elizaOS persistence policy: {missing}")

import re

start = text.index("class ElizaOSData")
end = text.index("class WelcomeScreen", start)
elizaos = text[start:end]
for name, target in re.findall(r'Binding\("([^"]+)", "([^"]+)"', elizaos):
    if not name.startswith("elizaos/"):
        continue
    if target == "/home/amnesia" or target.startswith(("/etc", "/usr", "/var", "/root", "/opt")):
        raise SystemExit(f"{path}: forbidden elizaOS persistence target: {name} -> {target}")
if "uses_symlinks=True" in elizaos:
    raise SystemExit(f"{path}: elizaOS persistence must use bind mounts, not symlink persistence")
PY

persistence_helper=tails/config/chroot_local-includes/usr/local/lib/elizaos/persistence-maintenance
require_fixed 'run_dir=/run/elizaos' "${persistence_helper}" \
    "persistence maintenance must use a root-owned runtime guard directory"
require_fixed 'flag="${run_dir}/persistence-maintenance"' "${persistence_helper}" \
    "persistence maintenance must expose an activation/deactivation guard"
require_fixed 'user_persistence_flag="${runtime_dir}/elizaos-persistence-setup"' "${persistence_helper}" \
    "persistence maintenance must also honor the user-session wizard guard"
require_fixed 'kill --kill-whom=all --signal=TERM' "${persistence_helper}" \
    "persistence maintenance must quiesce user services before bind changes"
require_fixed 'kill --kill-whom=all --signal=KILL' "${persistence_helper}" \
    "persistence maintenance must force-stop user services if graceful stop fails"
if grep -Eq 'pkill .* -u amnesia|rm -rf -- /home/amnesia($|/")|chown .* /home/amnesia' "${persistence_helper}"; then
    fail "persistence-maintenance must not mutate the whole live-user home"
fi
require_fixed 'args = ["enter"]' \
    tails/config/chroot_local-includes/etc/generate-sudoers.d/elizaos-persistence-maintenance.toml \
    "live user may only enter the narrow elizaOS persistence-maintenance helper"
require_fixed 'args = ["leave"]' \
    tails/config/chroot_local-includes/etc/generate-sudoers.d/elizaos-persistence-maintenance.toml \
    "live user may only leave the narrow elizaOS persistence-maintenance helper"

cache_hook=tails/config/chroot_local-includes/usr/local/lib/persistent-storage/on-activated-hooks/ElizaOSData/10-clean-runtime-state
require_file "${cache_hook}"
require_fixed 'find -P "${state_dir}" -xdev' "${cache_hook}" \
    "cache cleanup must not cross symlinks or filesystems"
if grep -Eq '/home/amnesia($|[[:space:]])|rm -rf -- /home/amnesia' "${cache_hook}"; then
    fail "cache cleanup must stay within elizaOS-owned persistence paths"
fi

echo "==> service constraints"
root_unit=tails/config/chroot_local-includes/etc/systemd/system/elizaos.service
require_fixed 'ExecStart=/usr/local/lib/elizaos/elizaos-keeper' "${root_unit}" \
    "root supervisor must run only the keeper"
require_fixed 'NoNewPrivileges=yes' "${root_unit}" \
    "root supervisor must disable privilege escalation"
require_fixed 'PrivateTmp=yes' "${root_unit}" \
    "root supervisor must use a private tmp"
require_fixed 'ProtectSystem=full' "${root_unit}" \
    "root supervisor must protect the system tree"
if grep -Eq 'ExecStart=.*(/usr/local/bin/elizaos|/opt/elizaos|launcher)' "${root_unit}"; then
    fail "root system service must not launch the app runtime directly"
fi

for unit in \
    tails/config/chroot_local-includes/etc/systemd/user/elizaos-agent.service \
    tails/config/chroot_local-includes/etc/systemd/user/elizaos-renderer.service \
    tails/config/chroot_local-includes/etc/systemd/user/elizaos.service
do
    require_fixed 'ConditionUser=1000' "${unit}" \
        "user service must be pinned to the live user"
    require_fixed 'ConditionPathExists=!/run/elizaos/persistence-maintenance' "${unit}" \
        "user service must stay down while Persistent Storage setup is active"
    require_fixed 'NoNewPrivileges=yes' "${unit}" \
        "user service must disable privilege escalation"
    if grep -q 'After=.*desktop.target' "${unit}"; then
        fail "user service must not wait on the inherited Tails desktop target: ${unit}"
    fi
done

for launcher in \
    tails/config/chroot_local-includes/usr/local/bin/elizaos \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/start-elizaos-agent-user \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/start-elizaos-renderer-user
do
    require_grep '127\.0\.0\.1|localhost|::1|normalize_loopback_bind' "${launcher}" \
        "elizaOS runtime launchers must bind local services to loopback"
done

echo "==> update signing and recovery markers"
if [ -d tails/config/chroot_local-includes/usr/src/iuk ]; then
    require_grep 'verify_signature|signature' \
        tails/config/chroot_local-includes/usr/src/iuk/lib/Tails/IUK/Utils.pm \
        "IUK stack must retain signature verification helpers"
    require_grep 'valid signature|invalid signature|trusted key|untrusted key' \
        tails/config/chroot_local-includes/usr/src/iuk/features/download_upgrade-description_file/Download_Upgrade-Description_File.feature \
        "IUK tests must cover signature trust outcomes"
fi

if ! rg -q 'app/runtime update|model catalog|signed app bundle|signed model' docs/distribution-and-updates.md docs/security-model.md; then
    fail "docs must define signed app/model update policy"
fi
if ! rg -q 'rollback|fail-closed|fail closed' docs/distribution-and-updates.md docs/security-model.md; then
    fail "docs must define update rollback and fail-closed policy"
fi
update_manager=tails/config/chroot_local-includes/usr/local/lib/elizaos/update-manager
runtime_env=tails/config/chroot_local-includes/usr/local/lib/elizaos/runtime-env
update_unit=tails/config/chroot_local-includes/etc/systemd/system/elizaos-update-verify.service
require_fixed 'gpgv --keyring' "${update_manager}" \
    "update manager must verify detached signed manifests"
require_fixed 'write_fallback_selector "missing-keyring"' "${update_manager}" \
    "update manager must fail closed when no trusted keyring is present"
require_fixed 'ELIZAOS_RUNTIME_ROOT' "${runtime_env}" \
    "runtime selector must export a runtime root for app wrappers"
require_fixed 'ExecStart=/usr/local/lib/elizaos/update-manager verify' "${update_unit}" \
    "boot unit must verify staged updates before selecting a runtime"
require_fixed 'modelCatalog' schemas/update-manifest.schema.json \
    "update manifest schema must cover a model catalog"
require_fixed 'filesComplete' schemas/update-manifest.schema.json \
    "update manifest schema must require complete runtime file inventories"
require_fixed 'elizaos.modelCatalog' schemas/model-catalog.schema.json \
    "model catalog schema must identify elizaOS model catalogs"
require_fixed 'contains unlisted file' "${update_manager}" \
    "update manager must reject files outside the signed runtime inventory"
require_fixed 'runtime_store' "${update_manager}" \
    "update manager must materialize verified runtimes into a root-owned store"
require_fixed 'os.O_NOFOLLOW' "${update_manager}" \
    "update manager must materialize files without following source symlinks"
require_fixed 'tempfile.mkstemp' "${update_manager}" \
    "update manager must materialize files through temporary files"
require_fixed 'verified runtime file changed while copying' "${update_manager}" \
    "update manager must re-check manifest digests during materialization"
if grep -q 'ELIZAOS_ALLOW_RUNTIME_ENV_OVERRIDES' "${runtime_env}"; then
    fail "runtime selector must not expose caller-controlled runtime override escape hatches"
fi
if grep -q 'ELIZAOS_BAKED_RUNTIME' "${runtime_env}"; then
    fail "runtime selector must not honor caller-supplied baked runtime paths"
fi
require_fixed 'mark-${action} must run as root' "${update_manager}" \
    "update promotion markers must be root-only"
require_fixed 'update-manager mark-good' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/update-health-check \
    "update health checker must promote healthy signed candidates"
require_fixed 'update-manager mark-bad' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/update-health-check \
    "update health checker must support rollback marking"
require_fixed 'ELIZAOS_UPDATE_HEALTH_MARK_BAD_ON_TIMEOUT' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/update-health-check \
    "update health checker must fail safe by default before rejecting candidates"

override_probe="$(
    ELIZAOS_RUNTIME_ENV_FILE=/tmp/elizaos-fake-runtime.env \
    ELIZAOS_BAKED_RUNTIME=/tmp/attacker \
    ELIZAOS_RUNTIME_ROOT=/tmp/attacker \
    ELIZAOS_BUN=/tmp/attacker/bin/bun \
        "${runtime_env}" print
)"
if printf '%s\n' "${override_probe}" | grep -q /tmp/attacker; then
    fail "runtime selector honored caller-supplied runtime override paths"
fi

tmp_mark="$(mktemp -d)"
trap 'rm -rf "${tmp_mark}"' EXIT
mkdir -p "${tmp_mark}/run" "${tmp_mark}/state"
cat > "${tmp_mark}/run/runtime-selection.json" <<'JSON'
{"trust":"signed","manifestSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","channel":"stable","sequence":1}
JSON
set +e
ELIZAOS_RUN_DIR="${tmp_mark}/run" \
ELIZAOS_UPDATE_STATE_DIR="${tmp_mark}/state" \
    "${update_manager}" mark-good >/dev/null 2>"${tmp_mark}/mark.err"
mark_code=$?
set -e
if [ "${mark_code}" -ne 77 ]; then
    fail "non-root mark-good must exit 77, got ${mark_code}"
fi
if find "${tmp_mark}/state" -type f | grep -q .; then
    fail "non-root mark-good wrote update state"
fi
rm -rf "${tmp_mark}"

if ! find tails/config/chroot_local-includes/usr/share/keyrings \
    tails/config/chroot_local-includes/etc/elizaos \
    -type f \( -name 'elizaos-update.gpg' -o -name 'update-keyring.gpg' \) 2>/dev/null | grep -q .
then
    strict_or_warn "production elizaOS update keyring is not baked yet"
fi

if command -v gpg >/dev/null 2>&1 && command -v gpgv >/dev/null 2>&1; then
    tmp="$(mktemp -d)"
    trap 'rm -rf "${tmp}"' EXIT
    export GNUPGHOME="${tmp}/gnupg"
    mkdir -m 700 "${GNUPGHOME}"
    gpg --batch --quiet --pinentry-mode loopback --passphrase '' \
        --quick-gen-key 'elizaOS smoke <smoke@elizaos.invalid>' ed25519 sign 1d
    gpg --batch --quiet --export 'smoke@elizaos.invalid' > "${tmp}/elizaos-update.gpg"

    runtime="${tmp}/staged/channels/stable/runtime"
    mkdir -p "${runtime}/bin" "${runtime}/Resources/app/eliza-dist/node_modules"
    printf '#!/bin/sh\nexit 0\n' > "${runtime}/bin/bun"
    printf '#!/bin/sh\nexit 0\n' > "${runtime}/bin/launcher"
    printf 'console.log("elizaOS smoke")\n' > "${runtime}/Resources/app/eliza-dist/entry.js"
    chmod 755 "${runtime}/bin/bun" "${runtime}/bin/launcher"
    bun_sha="$(sha256sum "${runtime}/bin/bun" | awk '{print $1}')"
    launcher_sha="$(sha256sum "${runtime}/bin/launcher" | awk '{print $1}')"
    entry_sha="$(sha256sum "${runtime}/Resources/app/eliza-dist/entry.js" | awk '{print $1}')"
    cat > "${tmp}/staged/channels/stable/manifest.json" <<EOF
{
  "schemaVersion": 1,
  "kind": "elizaos.updateManifest",
  "manifestVersion": "smoke",
  "channel": "stable",
  "sequence": 1,
  "publishedAt": "2026-05-17T00:00:00Z",
  "runtime": {
    "id": "smoke",
    "version": "0.0.1",
    "bundlePath": "runtime",
    "filesComplete": true,
    "entrypoints": {
      "bun": "bin/bun",
      "launcher": "bin/launcher",
      "agent": "Resources/app/eliza-dist/entry.js",
      "nodeModules": "Resources/app/eliza-dist/node_modules"
    },
    "files": [
      { "path": "bin/bun", "sha256": "${bun_sha}" },
      { "path": "bin/launcher", "sha256": "${launcher_sha}" },
      { "path": "Resources/app/eliza-dist/entry.js", "sha256": "${entry_sha}" }
    ]
  }
}
EOF
    gpg --batch --quiet --yes --pinentry-mode loopback --passphrase '' \
        --detach-sign --output "${tmp}/staged/channels/stable/manifest.json.sig" \
        "${tmp}/staged/channels/stable/manifest.json"

    ELIZAOS_UPDATE_KEYRING="${tmp}/elizaos-update.gpg" \
    ELIZAOS_STAGED_UPDATE_DIR="${tmp}/staged" \
    ELIZAOS_RUN_DIR="${tmp}/run-good" \
    ELIZAOS_RUNTIME_STORE="${tmp}/store" \
    ELIZAOS_UPDATE_STATE_DIR="${tmp}/state" \
        tails/config/chroot_local-includes/usr/local/lib/elizaos/update-manager verify
    require_fixed "ELIZAOS_RUNTIME_TRUST=signed" "${tmp}/run-good/runtime.env" \
        "signed smoke update must be selected"
    if grep -q "${tmp}/staged" "${tmp}/run-good/runtime.env"; then
        fail "signed runtime selector must point at the materialized store, not staged user storage"
    fi
    require_fixed "${tmp}/store" "${tmp}/run-good/runtime.env" \
        "signed runtime selector must point at the materialized store"
    materialized_entry="$(
        sed -n "s/^ELIZAOS_AGENT_ENTRY=//p" "${tmp}/run-good/runtime.env" | tr -d "'"
    )"
    printf 'materialized tamper\n' >> "${materialized_entry}"
    ELIZAOS_UPDATE_KEYRING="${tmp}/elizaos-update.gpg" \
    ELIZAOS_STAGED_UPDATE_DIR="${tmp}/staged" \
    ELIZAOS_RUN_DIR="${tmp}/run-materialized-tamper" \
    ELIZAOS_RUNTIME_STORE="${tmp}/store" \
    ELIZAOS_UPDATE_STATE_DIR="${tmp}/state" \
        tails/config/chroot_local-includes/usr/local/lib/elizaos/update-manager verify
    require_fixed "ELIZAOS_RUNTIME_TRUST='baked'" "${tmp}/run-materialized-tamper/runtime.env" \
        "tampered materialized runtime must fall back to baked runtime"
    rm -rf "${tmp}/store"

    printf 'extra\n' > "${runtime}/extra.js"
    ELIZAOS_UPDATE_KEYRING="${tmp}/elizaos-update.gpg" \
    ELIZAOS_STAGED_UPDATE_DIR="${tmp}/staged" \
    ELIZAOS_RUN_DIR="${tmp}/run-unlisted" \
    ELIZAOS_RUNTIME_STORE="${tmp}/store-unlisted" \
    ELIZAOS_UPDATE_STATE_DIR="${tmp}/state-unlisted" \
        tails/config/chroot_local-includes/usr/local/lib/elizaos/update-manager verify
    require_fixed "ELIZAOS_RUNTIME_TRUST='baked'" "${tmp}/run-unlisted/runtime.env" \
        "runtime with unlisted files must fall back to baked runtime"
    rm -f "${runtime}/extra.js"

    printf 'tampered\n' >> "${runtime}/Resources/app/eliza-dist/entry.js"
    ELIZAOS_UPDATE_KEYRING="${tmp}/elizaos-update.gpg" \
    ELIZAOS_STAGED_UPDATE_DIR="${tmp}/staged" \
    ELIZAOS_RUN_DIR="${tmp}/run-badhash" \
    ELIZAOS_RUNTIME_STORE="${tmp}/store-badhash" \
    ELIZAOS_UPDATE_STATE_DIR="${tmp}/state-badhash" \
        tails/config/chroot_local-includes/usr/local/lib/elizaos/update-manager verify
    require_fixed "ELIZAOS_RUNTIME_TRUST='baked'" "${tmp}/run-badhash/runtime.env" \
        "tampered signed runtime must fall back to baked runtime"
else
    strict_or_warn "gpg/gpgv unavailable; signed updater smoke was skipped"
fi
if ! rg -q 'gpgv --keyring|ELIZAOS_RELEASE_KEYRING|ELIZAOS_REQUIRE_ISO_SIGNATURE' scripts/usb-write.sh; then
    strict_or_warn "USB writer verifies checksum but not a release signature"
fi

echo "==> SBOM and provenance markers"
if ! rg -q 'SBOM|provenance|license bundle' docs/distribution-and-updates.md docs/security-model.md docs/production-readiness.md; then
    fail "docs must define SBOM/provenance release gates"
fi
require_file scripts/generate-release-evidence.mjs
if ! find . -maxdepth 4 -type f \( -iname '*sbom*' -o -iname '*provenance*' -o -iname '*attestation*' \) | grep -q .; then
    strict_or_warn "production SBOM/provenance artifacts are not generated in this distro"
fi

if [ "${failures}" -ne 0 ]; then
    echo "security smoke failed: ${failures} failure(s), ${warnings} warning(s)" >&2
    exit 1
fi

echo "security smoke passed: ${warnings} warning(s)"
