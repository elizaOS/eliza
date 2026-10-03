#!/usr/bin/env bash
# elizaOS Linux — unified multi-arch ISO build orchestrator.
#
# Runs end-to-end inside the builder container baked by ./Dockerfile.
# Steps:
#   1. lb config   — apply auto/config (arch-parameterized) to the tree.
#   2. lb build    — produce binary.hybrid.iso.
#   3. verify      — fail closed on missing/undersized/unparseable ISO.
#   4. checksum    — sha256 + size, written next to the artifact.
#   5. manifest    — substitute build evidence into
#                    manifest.json.template → out/<name>.manifest.json.
#
# Invocation:
#   docker build -t elizaos-linux-builder --build-arg ELIZAOS_ARCH=amd64 .
#   docker run --rm --privileged \
#       -e ELIZAOS_ARCH=amd64 \
#       -v "$(pwd):/build" -v "$(pwd)/out:/out" \
#       elizaos-linux-builder
#
# Tunables:
#   ELIZAOS_ARCH            amd64 | arm64 | riscv64 (default: amd64)
#   ELIZAOS_PROFILE         default | gui
#   ELIZAOS_OUT_DIR         override host-side output dir
#   ELIZAOS_MIN_ISO_BYTES   override 200 MiB minimum
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERE="${ELIZAOS_VARIANT_DIR:-${SCRIPT_DIR}}"
OUT="${ELIZAOS_OUT_DIR:-${HERE}/out}"

ARCH="${ELIZAOS_ARCH:-amd64}"
PROFILE="${ELIZAOS_PROFILE:-default}"
BUILD_TS="$(date -u +%Y%m%dT%H%M%SZ)"
ARTIFACT_BASENAME="elizaos-linux-${ARCH}-${PROFILE}-${BUILD_TS}"
MIN_ISO_BYTES="${ELIZAOS_MIN_ISO_BYTES:-209715200}"
case "${ARCH}" in
    amd64|arm64|riscv64) ;;
    *) echo "ERROR: unsupported ELIZAOS_ARCH=${ARCH}" >&2; exit 64 ;;
esac
case "${PROFILE}" in
    default|gui) ;;
    *) echo "ERROR: unsupported ELIZAOS_PROFILE=${PROFILE}; expected default or gui" >&2; exit 64 ;;
esac
if [[ ! "${MIN_ISO_BYTES}" =~ ^[1-9][0-9]{0,17}$ ]]; then
    echo "ERROR: ELIZAOS_MIN_ISO_BYTES must be a positive decimal integer of at most 18 digits" >&2
    exit 64
fi
HERE="$(cd "${HERE}" && pwd)"
TEMPLATE="${HERE}/manifest.${ARCH}.${PROFILE}.json.template"
if [ ! -f "${TEMPLATE}" ]; then
    if [ "${ARCH}:${PROFILE}" = "riscv64:default" ] && [ -f "${HERE}/manifest.json.template" ]; then
        TEMPLATE="${HERE}/manifest.json.template"
    else
        echo "ERROR: no release manifest contract for ${ARCH}:${PROFILE}: ${TEMPLATE}" >&2
        exit 69
    fi
fi

APP_SOURCE_COMMIT=""
APP_ARTIFACT_SHA256=""
DEBIAN_SNAPSHOT_SERIAL=""
DEBIAN_BASE_IMAGE=""
DEBIAN_SNAPSHOT_MIRROR=""
DEBIAN_SECURITY_MIRROR=""

mkdir -p "${OUT}"
# Resolve output before changing directory so caller-relative overrides retain
# their meaning. live-build itself operates on the selected variant tree.
OUT="$(cd "${OUT}" && pwd)"
cd "${HERE}"

remove_paths_recursive() {
    if [ "$#" -eq 0 ]; then
        return 0
    fi

    python3 - "$@" <<'PY'
from pathlib import Path
import shutil
import sys

cwd = Path.cwd().resolve()

for raw in sys.argv[1:]:
    if not raw:
        raise SystemExit("ERROR: refusing to remove an empty path")

    path = Path(raw)
    resolved = path.resolve(strict=False)
    if resolved == cwd:
        raise SystemExit(f"ERROR: refusing to remove the current working directory: {raw}")
    if resolved == resolved.parent:
        raise SystemExit(f"ERROR: refusing to remove a filesystem root: {raw}")

    if not path.exists() and not path.is_symlink():
        continue
    if path.is_symlink() or path.is_file():
        path.unlink()
    else:
        shutil.rmtree(path)
PY
}

verify_debian_snapshot_lock() {
    SNAPSHOT_LOCK="${HERE}/debian-snapshot.lock.json"
    [ -s "${SNAPSHOT_LOCK}" ] || {
        echo "ERROR: Debian snapshot lock is missing: ${SNAPSHOT_LOCK}" >&2
        exit 69
    }
    read -r DEBIAN_SNAPSHOT_SERIAL DEBIAN_BASE_IMAGE DEBIAN_SNAPSHOT_MIRROR DEBIAN_SECURITY_MIRROR < <(
        python3 - "${SNAPSHOT_LOCK}" <<'PY'
import json
from pathlib import Path
import re
import sys

lock = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
if lock.get("schema") != "eliza.os.linux.debian-snapshot-lock.v1":
    raise SystemExit("ERROR: Debian snapshot lock schema mismatch")
serial = lock.get("serial")
base = lock.get("baseImage")
archives = lock.get("archives", {})
if not isinstance(serial, str) or not re.fullmatch(r"[0-9]{8}T[0-9]{6}Z", serial):
    raise SystemExit("ERROR: Debian snapshot serial is invalid")
if not isinstance(base, str) or not re.fullmatch(r"debian:trixie@sha256:[0-9a-f]{64}", base):
    raise SystemExit("ERROR: Debian base image is not digest-pinned")
for name, entry in archives.items():
    url = entry.get("url")
    if not isinstance(url, str) or not url.endswith(f"/{serial}"):
        raise SystemExit(f"ERROR: {name} snapshot URL does not match serial")
    if not re.fullmatch(r"[0-9a-f]{64}", entry.get("releaseSha256", "")):
        raise SystemExit(f"ERROR: {name} Release digest is invalid")
for required in ("debian", "updates", "security"):
    if required not in archives:
        raise SystemExit(f"ERROR: Debian snapshot lock is missing {required}")
print(serial, base, archives["debian"]["url"], archives["security"]["url"])
PY
    )

    SNAPSHOT_TMP="$(mktemp -d)"
    python3 - "${SNAPSHOT_LOCK}" <<'PY' | while IFS=$'\t' read -r NAME URL EXPECTED; do
import json
from pathlib import Path
import sys

lock = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
for name, entry in lock["archives"].items():
    print(name, f'{entry["url"]}/{entry["releasePath"]}', entry["releaseSha256"], sep="\t")
PY
        FILE="${SNAPSHOT_TMP}/${NAME}.Release"
        curl --fail --location --silent --show-error --http1.1 \
            --retry 5 --retry-all-errors --retry-delay 2 \
            --connect-timeout 15 --max-time 120 "${URL}" -o "${FILE}"
        ACTUAL="$(sha256sum "${FILE}" | awk '{print $1}')"
        [ "${ACTUAL}" = "${EXPECTED}" ] || {
            echo "ERROR: ${NAME} snapshot Release digest mismatch: ${ACTUAL} != ${EXPECTED}" >&2
            exit 69
        }
    done
    remove_paths_recursive "${SNAPSHOT_TMP}"
    echo "    verified Debian snapshot ${DEBIAN_SNAPSHOT_SERIAL}: main, updates, security Release digests"
}

if ! command -v lb >/dev/null 2>&1; then
    echo "ERROR: live-build (lb) not found on PATH. Run inside the builder container." >&2
    exit 1
fi
if ! command -v xorriso >/dev/null 2>&1; then
    echo "ERROR: xorriso is required to validate the built ISO." >&2
    exit 69
fi

verify_debian_snapshot_lock

ensure_foreign_binfmt() {
    case "${ARCH}" in
        amd64)
            return 0
            ;;
        arm64)
            BINFMT_NAME=qemu-aarch64
            ;;
        riscv64)
            BINFMT_NAME=qemu-riscv64
            ;;
        *)
            echo "ERROR: unsupported ELIZAOS_ARCH=${ARCH}" >&2
            exit 64
            ;;
    esac

    if [ "$(dpkg --print-architecture 2>/dev/null || true)" = "${ARCH}" ]; then
        return 0
    fi

    echo "    ensuring ${BINFMT_NAME} binfmt_misc registration..."

    if [ ! -d /proc/sys/fs/binfmt_misc ]; then
        echo "ERROR: /proc/sys/fs/binfmt_misc missing; foreign ${ARCH} bootstrap cannot run." >&2
        exit 65
    fi

    if [ ! -e /proc/sys/fs/binfmt_misc/register ]; then
        mount -t binfmt_misc binfmt_misc /proc/sys/fs/binfmt_misc 2>/dev/null || true
    fi

    if [ ! -e /proc/sys/fs/binfmt_misc/register ]; then
        echo "ERROR: binfmt_misc is not mounted; run the builder container with --privileged." >&2
        exit 65
    fi

    if [ -e "/proc/sys/fs/binfmt_misc/${BINFMT_NAME}" ]; then
        if grep -q '^enabled' "/proc/sys/fs/binfmt_misc/${BINFMT_NAME}"; then
            return 0
        fi
        echo 1 >"/proc/sys/fs/binfmt_misc/${BINFMT_NAME}" 2>/dev/null || true
        if grep -q '^enabled' "/proc/sys/fs/binfmt_misc/${BINFMT_NAME}"; then
            return 0
        fi
        echo -1 >"/proc/sys/fs/binfmt_misc/${BINFMT_NAME}" 2>/dev/null || true
    fi

    BINFMT_CONF="/usr/lib/binfmt.d/${BINFMT_NAME}.conf"
    if [ ! -r "${BINFMT_CONF}" ]; then
        BINFMT_CONF="/usr/share/qemu/binfmt.d/${BINFMT_NAME}.conf"
    fi

    if [ ! -r "${BINFMT_CONF}" ]; then
        echo "ERROR: no ${BINFMT_NAME} binfmt config found in the builder image." >&2
        exit 65
    fi

    BINFMT_LINE="$(sed -n '1p' "${BINFMT_CONF}")"
    if [ -z "${BINFMT_LINE}" ]; then
        echo "ERROR: ${BINFMT_CONF} is empty." >&2
        exit 65
    fi

    printf '%s\n' "${BINFMT_LINE}" >/proc/sys/fs/binfmt_misc/register

    if [ ! -e "/proc/sys/fs/binfmt_misc/${BINFMT_NAME}" ] ||
        ! grep -q '^enabled' "/proc/sys/fs/binfmt_misc/${BINFMT_NAME}"; then
        echo "ERROR: failed to register ${BINFMT_NAME} with binfmt_misc." >&2
        exit 65
    fi
}

patch_live_build_riscv64_grub_efi() {
    if [ "${ARCH}" != "riscv64" ]; then
        return 0
    fi

    GRUB_EFI_SCRIPT="/usr/lib/live/build/binary_grub-efi"
    if [ ! -w "${GRUB_EFI_SCRIPT}" ]; then
        echo "ERROR: cannot patch ${GRUB_EFI_SCRIPT}; builder image is not writable." >&2
        exit 66
    fi
    if grep -q 'grub-efi-riscv64-bin' "${GRUB_EFI_SCRIPT}" \
        && grep -q 'gen_efi_boot_img "riscv64-efi" "riscv64"' "${GRUB_EFI_SCRIPT}" \
        && grep -q 'binary/boot/grub/riscv64-efi' "${GRUB_EFI_SCRIPT}"; then
        return 0
    fi

    echo "    patching live-build grub-efi support for riscv64..."
    python3 - "${GRUB_EFI_SCRIPT}" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
remove_recursive = "rm -" "rf"

replacements = [
    (
        '\tarmhf)\n'
        '\t\tCheck_package chroot /usr/lib/grub/arm-efi/configfile.mod grub-efi-arm-bin\n'
        '\t\t;;\n',
        '\tarmhf)\n'
        '\t\tCheck_package chroot /usr/lib/grub/arm-efi/configfile.mod grub-efi-arm-bin\n'
        '\t\t;;\n'
        '\triscv64)\n'
        '\t\tCheck_package chroot /usr/lib/grub/riscv64-efi/configfile.mod grub-efi-riscv64-bin\n'
        '\t\t;;\n',
    ),
    (
        '\tarmhf)\n'
        '\t\t_SB_EFI_PLATFORM="arm"\n'
        '\t\t_SB_EFI_NAME="arm"\n'
        '\t\t_SB_EFI_DEB="arm"\n'
        '\t\t;;\n',
        '\tarmhf)\n'
        '\t\t_SB_EFI_PLATFORM="arm"\n'
        '\t\t_SB_EFI_NAME="arm"\n'
        '\t\t_SB_EFI_DEB="arm"\n'
        '\t\t;;\n'
        '\triscv64)\n'
        '\t\t_SB_EFI_PLATFORM="riscv64"\n'
        '\t\t_SB_EFI_NAME="riscv64"\n'
        '\t\t_SB_EFI_DEB="riscv64"\n'
        '\t\t;;\n',
    ),
    (
        'binary/boot/grub/arm64-efi binary/boot/grub/arm-efi',
        'binary/boot/grub/arm64-efi binary/boot/grub/riscv64-efi binary/boot/grub/arm-efi',
    ),
    (
        '\tarmhf)\n'
        '\t\tgen_efi_boot_img "arm-efi" "arm" "debian-live/arm"\n'
        '\t\tPATH="\\${PRE_EFI_IMAGE_PATH}"\n'
        '\t\t;;\n',
        '\tarmhf)\n'
        '\t\tgen_efi_boot_img "arm-efi" "arm" "debian-live/arm"\n'
        '\t\tPATH="\\${PRE_EFI_IMAGE_PATH}"\n'
        '\t\t;;\n'
        '\triscv64)\n'
        '\t\tgen_efi_boot_img "riscv64-efi" "riscv64" "debian-live/riscv64"\n'
        '\t\tPATH="\\${PRE_EFI_IMAGE_PATH}"\n'
        '\t\t;;\n',
    ),
    (
        f'{remove_recursive} chroot/grub-efi-temp-arm-efi\n',
        f'{remove_recursive} chroot/grub-efi-temp-arm-efi\n'
        f'{remove_recursive} chroot/grub-efi-temp-riscv64-efi\n',
    ),
]

for old, new in replacements:
    if old not in text:
        raise SystemExit(f"live-build riscv64 grub-efi patch anchor missing: {old!r}")
    text = text.replace(old, new, 1)

path.write_text(text)
PY

    if ! grep -q 'gen_efi_boot_img "riscv64-efi" "riscv64"' "${GRUB_EFI_SCRIPT}"; then
        echo "ERROR: failed to patch live-build riscv64 grub-efi support." >&2
        exit 66
    fi
}

patch_debootstrap_curl_downloader() {
    FUNCTIONS="/usr/share/debootstrap/functions"
    if [ ! -w "${FUNCTIONS}" ]; then
        echo "ERROR: cannot patch ${FUNCTIONS}; builder image is not writable." >&2
        exit 67
    fi
    if grep -q 'elizaOS curl downloader patch' "${FUNCTIONS}"; then
        return 0
    fi

    echo "    patching debootstrap downloader to use curl retries..."
    python3 - "${FUNCTIONS}" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
old = '''\telif [ "${from#http://}" != "$from" ] || [ "${from#https://}" != "$from" ] || [ "${from#ftp://}" != "$from" ]; then
\t\t# http/https/ftp mirror
\t\tif wgetprogress ${CHECKCERTIF:+"$CHECKCERTIF"} ${CERTIFICATE:+"$CERTIFICATE"} ${PRIVATEKEY:+"$PRIVATEKEY"} -O "$dest" "$from"; then
\t\t\treturn 0
\t\telse
\t\t\trm -f "$dest"
\t\t\treturn 1
\t\tfi
'''
new = '''\telif [ "${from#http://}" != "$from" ] || [ "${from#https://}" != "$from" ] || [ "${from#ftp://}" != "$from" ]; then
\t\t# elizaOS curl downloader patch: wget intermittently returned corrupt
\t\t# partial .deb payloads in this builder environment.
\t\tif command -v curl >/dev/null 2>&1 && curl --silent --show-error --fail --location --retry 12 --retry-all-errors --connect-timeout 20 --max-time 300 --speed-limit 1024 --speed-time 45 --output "$dest" "$from"; then
\t\t\treturn 0
\t\telif wgetprogress ${CHECKCERTIF:+"$CHECKCERTIF"} ${CERTIFICATE:+"$CERTIFICATE"} ${PRIVATEKEY:+"$PRIVATEKEY"} -O "$dest" "$from"; then
\t\t\treturn 0
\t\telse
\t\t\trm -f "$dest"
\t\t\treturn 1
\t\tfi
'''
if old not in text:
    raise SystemExit("debootstrap downloader patch anchor missing")
path.write_text(text.replace(old, new, 1))
PY
}

configure_wget_ipv4_only() {
    # live-build fetches Contents indexes with wget outside debootstrap.
    # The mirrors' IPv6 path can time out repeatedly here before succeeding
    # over IPv4, so force IPv4 for deterministic multi-arch build latency.
    if ! grep -q '^inet4_only = on$' /etc/wgetrc 2>/dev/null; then
        echo "inet4_only = on" >> /etc/wgetrc
    fi
}

patch_debootstrap_foreign_dpkg_io() {
    if [ "${ARCH}" = "amd64" ]; then
        return 0
    fi

    SCRIPT="/usr/share/debootstrap/scripts/debian-common"
    FUNCTIONS="/usr/share/debootstrap/functions"
    if [ ! -w "${SCRIPT}" ] || [ ! -w "${FUNCTIONS}" ]; then
        echo "ERROR: cannot patch debootstrap scripts; builder image is not writable." >&2
        exit 68
    fi
    if grep -q 'elizaOS foreign dpkg unsafe-io patch' "${SCRIPT}"; then
        return 0
    fi

    echo "    patching foreign debootstrap dpkg unpack I/O..."
    python3 - "${SCRIPT}" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
text = text.replace(
    "dpkg --status-fd 8 --force-depends --unpack $(debfor $required)",
    "dpkg --status-fd 8 --force-depends --force-unsafe-io --unpack $(debfor $required)",
    1,
)
text = text.replace(
    "dpkg --status-fd 8 --force-overwrite --force-confold --skip-same-version --unpack $(debfor $base)",
    "dpkg --status-fd 8 --force-overwrite --force-confold --force-unsafe-io --skip-same-version --unpack $(debfor $base)",
    1,
)
text = text.replace(
    "in_target dpkg --force-overwrite --force-confold --skip-same-version --install $(debfor $predep)",
    "in_target dpkg --force-overwrite --force-confold --force-unsafe-io --skip-same-version --install $(debfor $predep)",
    1,
)
if "--force-depends --force-unsafe-io --unpack" not in text:
    raise SystemExit("debootstrap required dpkg unsafe-io patch anchor missing")
if "--force-confold --force-unsafe-io --skip-same-version --unpack" not in text:
    raise SystemExit("debootstrap base dpkg unsafe-io patch anchor missing")
if "--force-confold --force-unsafe-io --skip-same-version --install" not in text:
    raise SystemExit("debootstrap predep dpkg unsafe-io patch anchor missing")
text += "\n# elizaOS foreign dpkg unsafe-io patch\n"
path.write_text(text)
PY
    python3 - "${FUNCTIONS}" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
old = "if [ $ARCH_ALL_SUPPORTED -eq 1 ]; then"
new = 'if [ "${ARCH_ALL_SUPPORTED:-0}" -eq 1 ]; then'
if old not in text:
    raise SystemExit("debootstrap ARCH_ALL_SUPPORTED patch anchor missing")
path.write_text(text.replace(old, new))
PY
}

stage_agent_artifacts_for_live_build() {
    ART="${ELIZAOS_AGENT_ARTIFACTS_DIR:-/opt/elizaos-artifacts}"
    CHROOT_ART="${HERE}/config/includes.chroot/opt/elizaos-artifacts"

    # This directory is generated for one build only. Never let a previous
    # staging run (or checked-in generated bytes) satisfy a later image build.
    remove_paths_recursive "${CHROOT_ART}"

    if [ ! -d "${ART}" ]; then
        if [ -x "${ELIZAOS_PACKAGED_APP_DIR:-/opt/elizaos-packaged-app}/bin/launcher" ]; then
            echo "    packaged desktop app owns the agent runtime; no separate agent artifacts needed."
            return 0
        fi
        echo "ERROR: ${ART} missing; mount freshly staged agent artifacts or a packaged desktop app." >&2
        exit 69
    fi

    if [ ! -e "${ART}/elizaos-app" ]; then
        echo "ERROR: required elizaOS agent artifact missing: ${ART}/elizaos-app" >&2
        exit 69
    fi
    if [ ! -e "${ART}/bun" ] && [ "${ARCH}" != "riscv64" ]; then
        echo "ERROR: required elizaOS agent artifact missing: ${ART}/bun" >&2
        exit 69
    fi
    if [ ! -e "${ART}/bun" ] && [ ! -f "${ART}/elizaos-app/agent-bundle.js" ]; then
        echo "ERROR: riscv64 Node fallback requires ${ART}/elizaos-app/agent-bundle.js when Bun is absent." >&2
        exit 69
    fi
    if [ "${ARCH}" = "riscv64" ] && [ -e "${ART}/bun" ] && grep -q 'musl-runtime/bun' "${ART}/bun"; then
        if [ ! -x "${ART}/elizaos-app/musl-runtime/bun" ]; then
            echo "ERROR: riscv64 Bun wrapper requires ${ART}/elizaos-app/musl-runtime/bun." >&2
            exit 69
        fi
        if [ ! -f "${ART}/riscv64-bun-provenance.json" ]; then
            echo "ERROR: riscv64 agent artifacts require ${ART}/riscv64-bun-provenance.json." >&2
            echo "Run make stage-agent-artifacts ARCH=riscv64 after rebuilding the current Bun riscv64 zip." >&2
            exit 69
        fi
        python3 - "${ART}/riscv64-bun-provenance.json" "${ART}/elizaos-app/musl-runtime/bun" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

provenance = Path(sys.argv[1])
bun = Path(sys.argv[2])


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


data = json.loads(provenance.read_text(encoding="utf-8"))
if data.get("schema") != "eliza.os.linux.riscv64_bun_stage_provenance.v1":
    raise SystemExit(f"ERROR: riscv64 Bun provenance schema mismatch: {data.get('schema')!r}")
artifact = data.get("artifact", {})
if artifact.get("staged_bun_sha256") != sha256_file(bun):
    raise SystemExit("ERROR: riscv64 Bun provenance staged_bun_sha256 does not match staged Bun")
inputs = data.get("inputs", {})
if not isinstance(inputs, dict) or "toolchains/bun-riscv64/bun-version.json" not in inputs:
    raise SystemExit("ERROR: riscv64 Bun provenance does not record bun-version.json")
PY
    fi

    echo "    staging elizaOS agent artifacts into live-build chroot includes..."
    remove_paths_recursive "${CHROOT_ART}"
    mkdir -p "${CHROOT_ART}"
    rsync -a "${ART}/" "${CHROOT_ART}/"
}

stage_packaged_app_for_live_build() {
    PACKAGED_APP="${ELIZAOS_PACKAGED_APP_DIR:-/opt/elizaos-packaged-app}"
    CHROOT_APP="${HERE}/config/includes.chroot/usr/share/elizaos/elizaos-app"
    APP_LOCK="${HERE}/app-source.lock.json"
    APP_BUILD_INFO="${PACKAGED_APP}/Resources/app/eliza-dist/build-info.json"

    if [ ! -d "${PACKAGED_APP}" ]; then
        echo "    no packaged elizaOS desktop app mounted at ${PACKAGED_APP}."
        return 0
    fi
    if [ ! -x "${PACKAGED_APP}/bin/launcher" ]; then
        echo "ERROR: packaged app is missing executable bin/launcher: ${PACKAGED_APP}" >&2
        exit 69
    fi
    if [ ! -d "${PACKAGED_APP}/Resources/app/eliza-dist/node_modules" ]; then
        echo "ERROR: packaged app is missing its offline runtime dependency closure." >&2
        exit 69
    fi
    if [ ! -f "${APP_LOCK}" ]; then
        echo "ERROR: packaged app source lock is missing: ${APP_LOCK}" >&2
        exit 69
    fi
    if [ ! -f "${APP_BUILD_INFO}" ]; then
        echo "ERROR: packaged app build metadata is missing: ${APP_BUILD_INFO}" >&2
        exit 69
    fi

    read -r APP_SOURCE_COMMIT LOCKED_APP_COMMIT < <(
        python3 - "${APP_BUILD_INFO}" "${APP_LOCK}" <<'PY'
import json
from pathlib import Path
import re
import sys

build_info = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
lock = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
actual = build_info.get("commit")
expected = lock.get("commit")
sha = re.compile(r"^[0-9a-f]{40}$")
if not isinstance(actual, str) or not sha.fullmatch(actual):
    raise SystemExit("ERROR: packaged app build-info commit is not a full Git SHA")
if not isinstance(expected, str) or not sha.fullmatch(expected):
    raise SystemExit("ERROR: app-source.lock.json commit is not a full Git SHA")
print(actual, expected)
PY
    )
    if [ "${APP_SOURCE_COMMIT}" != "${LOCKED_APP_COMMIT}" ]; then
        echo "ERROR: packaged app commit ${APP_SOURCE_COMMIT} does not match lock ${LOCKED_APP_COMMIT}." >&2
        exit 69
    fi

    APP_ARTIFACT_SHA256="$(python3 - "${PACKAGED_APP}" <<'PY'
from hashlib import sha256
from pathlib import Path
import os
import stat
import sys

root = Path(sys.argv[1])
digest = sha256()
for path in sorted(root.rglob("*"), key=lambda item: item.relative_to(root).as_posix()):
    relative = path.relative_to(root).as_posix().encode()
    metadata = path.lstat()
    if path.is_symlink():
        kind = b"L"
        payload = os.readlink(path).encode()
    elif path.is_dir():
        kind = b"D"
        payload = b""
    elif path.is_file():
        kind = b"F"
        payload = b""
    else:
        raise SystemExit(f"ERROR: unsupported packaged app entry: {relative.decode()}")
    digest.update(kind + b"\0" + relative + b"\0")
    digest.update(f"{stat.S_IMODE(metadata.st_mode):04o}".encode() + b"\0")
    if kind == b"F":
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    else:
        digest.update(payload)
    digest.update(b"\0")
print(digest.hexdigest())
PY
)"

    echo "    staging verified packaged elizaOS desktop runtime..."
    remove_paths_recursive "${CHROOT_APP}"
    mkdir -p "${CHROOT_APP}"
    rsync -a "${PACKAGED_APP}/" "${CHROOT_APP}/"
    install -D -m 0644 "${APP_LOCK}" \
        "${HERE}/config/includes.chroot/usr/share/elizaos/app-source.lock.json"
    printf '%s  elizaos-app-tree\n' "${APP_ARTIFACT_SHA256}" > \
        "${HERE}/config/includes.chroot/usr/share/elizaos/elizaos-app.sha256"
}

# Clear every live-build working directory from any prior/interrupted run so
# binary assembly cannot restore an incomplete chroot from a stale cache. Runs
# as root here, so it can remove root-owned state left by earlier builds.
remove_paths_recursive "${HERE}/.build" "${HERE}/binary" "${HERE}/cache" "${HERE}/chroot" \
    "${HERE}/config/binary" "${HERE}/config/bootstrap" "${HERE}/config/chroot" \
    "${HERE}/config/common" "${HERE}/config/source" \
    "${HERE}"/chroot.* "${HERE}"/binary.* "${HERE}"/live-image-*
rm -f "${HERE}/.lock"

# Profile overlays are copied into live-build's mutable config/ tree below.
# Remove overlay-owned files before each run so `ELIZAOS_PROFILE=gui ./build-live-iso.sh`
# followed by `ELIZAOS_PROFILE=default ./build-live-iso.sh` cannot leave GUI packages in
# the headless default image.
rm -f "${HERE}/config/package-lists/elizaos-gui.list.chroot"

echo "=== elizaOS Linux build ==="
echo "    arch:        ${ARCH}"
echo "    profile:     ${PROFILE}"
echo "    output dir:  ${OUT}"
echo "    build ts:    ${BUILD_TS}"


if [ -d "${ELIZAOS_PACKAGED_APP_DIR:-/opt/elizaos-packaged-app}" ]; then
    if [ "${ARCH}" != "amd64" ]; then
        echo "ERROR: the currently published packaged desktop artifact is amd64-only; refusing to copy it into ${ARCH}." >&2
        exit 69
    fi
elif [ "${PROFILE}" = "gui" ] && [ "${ARCH}" = "amd64" ]; then
    echo "ERROR: amd64 GUI images require a mounted packaged elizaOS desktop artifact." >&2
    exit 69
fi

ensure_foreign_binfmt
patch_debootstrap_curl_downloader
configure_wget_ipv4_only
patch_debootstrap_foreign_dpkg_io
patch_live_build_riscv64_grub_efi

# ── Step 1: lb config ────────────────────────────────────────────────
echo
echo "--- step 1/5: lb config ---"
ELIZAOS_ARCH="${ARCH}" \
ELIZAOS_DEBIAN_MIRROR="${DEBIAN_SNAPSHOT_MIRROR}" \
ELIZAOS_DEBIAN_SECURITY_MIRROR="${DEBIAN_SECURITY_MIRROR}" \
    "${HERE}/auto/config"
rm -f "${HERE}/.lock"

# Compose optional overlays on top of the base headless config.
if [ "${PROFILE}" = "gui" ]; then
    if [ -d "${HERE}/config/profiles/gui" ]; then
        echo "    overlaying gui profile..."
        cp -a "${HERE}/config/profiles/gui/." "${HERE}/config/"
    fi
fi

# Generate all raster assets consumed by the live-build branding hooks.
bash "${SCRIPT_DIR}/../../scripts/linux/generate-elizaos-brand-assets.sh" "${HERE}"
stage_agent_artifacts_for_live_build
stage_packaged_app_for_live_build

# ── Step 2: lb build ─────────────────────────────────────────────────
echo
echo "--- step 2/5: lb build (this takes 30+ minutes) ---"
lb build

# ── Step 3: verify ───────────────────────────────────────────────────
echo
echo "--- step 3/5: verify ---"
# live-build names the image live-image-<arch>.hybrid.iso; older trees used
# binary.hybrid.iso. Require exactly one regular, non-symlink output.
SRC_ISO=""
for candidate in \
    "${HERE}/live-image-${ARCH}.hybrid.iso" \
    "${HERE}/binary.hybrid.iso"; do
    if [ -L "${candidate}" ] || { [ -e "${candidate}" ] && [ ! -f "${candidate}" ]; }; then
        echo "ERROR: ISO output is not a regular non-symlink file: ${candidate}" >&2
        exit 2
    fi
    if [ -f "${candidate}" ]; then
        if [ -n "${SRC_ISO}" ]; then
            echo "ERROR: multiple expected ISO outputs; refusing ambiguous artifact selection" >&2
            exit 2
        fi
        SRC_ISO="${candidate}"
    fi
done
if [ -z "${SRC_ISO}" ]; then
    echo "ERROR: no expected ${ARCH} ISO produced by lb build in ${HERE}." >&2
    exit 2
fi

ISO_BYTES="$(stat -c%s "${SRC_ISO}")"
if [ "${ISO_BYTES}" -lt "${MIN_ISO_BYTES}" ]; then
    echo "ERROR: ISO size ${ISO_BYTES} below minimum ${MIN_ISO_BYTES} bytes." >&2
    exit 3
fi

# xorriso otherwise treats non-ISO input as a blank image with a warning.
xorriso -abort_on WARNING -return_with WARNING 32 -indev "${SRC_ISO}" -pvd_info >/dev/null

DST_ISO="${OUT}/${ARTIFACT_BASENAME}.iso"
for suffix in iso iso.sha256 manifest.json; do
    destination="${OUT}/${ARTIFACT_BASENAME}.${suffix}"
    if [ -e "$destination" ] || [ -L "$destination" ]; then
        echo "ERROR: refusing to overwrite existing release output: $destination" >&2
        exit 73
    fi
done
mv -T --update=none-fail -- "${SRC_ISO}" "${DST_ISO}"
echo "    artifact: ${DST_ISO}"

# ── Step 4: checksum ─────────────────────────────────────────────────
echo
echo "--- step 4/5: checksum ---"
( set -o noclobber; cd "${OUT}" && sha256sum "$(basename "${DST_ISO}")" > "${ARTIFACT_BASENAME}.iso.sha256" )
echo "    sha256: $(cat "${OUT}/${ARTIFACT_BASENAME}.iso.sha256")"

# ── Step 5: manifest ─────────────────────────────────────────────────
echo
echo "--- step 5/5: manifest ---"
SHA256="$(awk '{print $1}' "${OUT}/${ARTIFACT_BASENAME}.iso.sha256")"
python3 - "${TEMPLATE}" "${OUT}/${ARTIFACT_BASENAME}.manifest.json" \
    "${ARCH}" "${PROFILE}" "${ARTIFACT_BASENAME}.iso" "${BUILD_TS}" \
    "${SHA256}" "${ISO_BYTES}" "${APP_SOURCE_COMMIT}" "${APP_ARTIFACT_SHA256}" \
    "${DEBIAN_SNAPSHOT_SERIAL}" "${DEBIAN_BASE_IMAGE}" <<'PY_MANIFEST'
import json
from pathlib import Path
import re
import sys

source, destination, *values = sys.argv[1:]
keys = ("ARCH", "PROFILE", "FILENAME", "BUILD_TIMESTAMP", "SHA256", "SIZE_BYTES",
        "ELIZA_COMMIT", "APP_ARTIFACT_SHA256", "DEBIAN_SNAPSHOT_SERIAL", "DEBIAN_BASE_IMAGE")
text = Path(source).read_text(encoding="utf-8")
for key, value in zip(keys, values, strict=True):
    text = text.replace(f"@@{key}@@", value)
if re.search(r"@@[^@]+@@", text):
    raise SystemExit("ERROR: release manifest contains unresolved placeholders")
manifest = json.loads(text)
with open(destination, "x", encoding="utf-8") as output:
    json.dump(manifest, output, indent=2)
    output.write("\n")
PY_MANIFEST
echo "    manifest: ${OUT}/${ARTIFACT_BASENAME}.manifest.json"

echo
echo "=== done ==="
