#!/usr/bin/env bash
# Sync runtime overlay edits into an existing live-build chroot for an
# incremental `./build.sh binary` repack. Full builds do not need this.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OVERLAY="${ROOT}/tails/config/chroot_local-includes"
CHROOT="${ROOT}/tails/chroot"
APP_STAGE="${OVERLAY}/usr/share/elizaos/milady-app"

if [ ! -d "${CHROOT}" ]; then
    echo "ERROR: ${CHROOT} does not exist; run a full build first." >&2
    exit 1
fi

if [ ! -x "${APP_STAGE}/bin/launcher" ]; then
    echo "ERROR: staged elizaOS app is missing ${APP_STAGE}/bin/launcher." >&2
    exit 1
fi

sync_file() {
    local rel="$1"
    local src="${OVERLAY}/${rel}"
    local dst="${CHROOT}/${rel}"
    if [ ! -e "${src}" ]; then
        echo "ERROR: missing overlay file ${src}" >&2
        exit 1
    fi
    sudo mkdir -p "$(dirname "${dst}")"
    sudo rsync -a --chown=root:root "${src}" "${dst}"
}

copy_perl_module() {
    local src_rel="$1"
    local module_rel="$2"
    local src="${OVERLAY}/${src_rel}"
    local dst
    dst="$(sudo find "${CHROOT}/usr/local/share/perl" -path "*/${module_rel}" -print -quit)"
    if [ -z "${dst}" ]; then
        echo "ERROR: installed Perl module ${module_rel} not found in ${CHROOT}" >&2
        exit 1
    fi
    sudo rsync -a --chown=root:root "${src}" "${dst}"
}

runtime_files=(
    etc/whisperback/config.py
    usr/lib/systemd/user/tails-additional-software-install.service
    usr/lib/systemd/user/tails-configure-keyboard.service
    usr/lib/systemd/user/tails-htpdate-notify-user.service
    usr/lib/systemd/user/tails-low-ram-notify-user.service
    usr/lib/systemd/user/tails-post-greeter-docs.service
    usr/lib/systemd/user/tails-post-greeter-whisperback.service
    usr/lib/systemd/user/tails-report-disk-partitioning-errors.service
    usr/lib/systemd/user/tails-report-mac-spoofing-failed.service
    usr/lib/systemd/user/tails-security-check.service
    usr/lib/systemd/user/tails-uefi-ca-notify-user.service
    usr/lib/systemd/user/tails-upgrade-frontend.service
    usr/lib/systemd/user/tails-virt-notify-user.service
    usr/lib/systemd/user/tails-wait-until-tor-has-bootstrapped.service
    usr/local/bin/tails-about
    usr/local/bin/tails-security-check
    usr/local/bin/tails-upgrade-frontend-wrapper
    usr/local/lib/tails-boot-device-can-have-persistence
    usr/share/tails/persistent-storage/style.css
    usr/share/whisperback/whisperback.ui.in
)

for rel in "${runtime_files[@]}"; do
    sync_file "${rel}"
done

copy_perl_module usr/src/iuk/lib/Tails/IUK/Frontend.pm Tails/IUK/Frontend.pm
copy_perl_module usr/src/iuk/lib/Tails/IUK/Install.pm Tails/IUK/Install.pm
copy_perl_module usr/src/perl5lib/lib/Tails/RunningSystem.pm Tails/RunningSystem.pm

sudo rm -rf "${CHROOT}/usr/share/elizaos/milady-app"
sudo mkdir -p "${CHROOT}/usr/share/elizaos"
sudo rsync -a --delete --chown=root:root "${APP_STAGE}/" \
    "${CHROOT}/usr/share/elizaos/milady-app/"
sudo chroot "${CHROOT}" /bin/sh -s < "${ROOT}/tails/config/chroot_local-hooks/9100-install-milady"

echo "Synced elizaOS runtime overlay into ${CHROOT}"
