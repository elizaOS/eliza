#!/usr/bin/env bash
# Sync runtime overlay edits into an existing live-build chroot for an
# incremental `./build.sh binary` repack. Full builds do not need this.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OVERLAY="${ROOT}/tails/config/chroot_local-includes"
CHROOT="${ROOT}/tails/chroot"
APP_STAGE="${OVERLAY}/usr/share/elizaos/milady-app"

run_root() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    else
        sudo "$@"
    fi
}

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
    run_root mkdir -p "$(dirname "${dst}")"
    run_root rsync -a --chown=root:root "${src}" "${dst}"
}

copy_perl_module() {
    local src_rel="$1"
    local module_rel="$2"
    local src="${OVERLAY}/${src_rel}"
    local dst
    dst="$(run_root find "${CHROOT}/usr/local/share/perl" -path "*/${module_rel}" -print -quit)"
    if [ -z "${dst}" ]; then
        echo "ERROR: installed Perl module ${module_rel} not found in ${CHROOT}" >&2
        exit 1
    fi
    run_root rsync -a --chown=root:root "${src}" "${dst}"
}

runtime_files=(
    etc/gdm3/PostLogin/Default
    etc/generate-sudoers.d/elizaos-capability-runner.toml
    etc/generate-sudoers.d/elizaos-persistence-maintenance.toml
    etc/systemd/system/elizaos-root-mode.service
    etc/systemd/system/elizaos-update-health-check.service
    etc/systemd/system/elizaos-update-verify.service
    etc/systemd/system/milady.path
    etc/systemd/system/milady.service
    etc/systemd/user/elizaos-agent.service
    etc/systemd/user/elizaos-pill.service
    etc/systemd/user/elizaos-renderer.service
    etc/systemd/user/milady.service
    etc/whisperback/config.py
    usr/lib/systemd/user/tails-additional-software-install.service
    usr/lib/systemd/user/tails-configure-keyboard.service
    usr/lib/systemd/user/tails-create-persistent-storage.service
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
    usr/lib/python3/dist-packages/tps/configuration/features.py
    usr/lib/python3/dist-packages/tps_frontend/views/features_view.py
    usr/lib/python3/dist-packages/tailsgreeter/ui/main_window.py
    usr/local/bin/milady
    usr/local/bin/tails-persistent-storage
    usr/local/bin/tails-about
    usr/local/bin/tails-security-check
    usr/local/bin/tails-upgrade-frontend-wrapper
    usr/local/lib/elizaos/capability-runner
    usr/local/lib/elizaos/create-persistent-storage-session
    usr/local/lib/elizaos/elizaos-webkit-shell
    usr/local/lib/elizaos/milady-keeper
    usr/local/lib/elizaos/persistence-maintenance
    usr/local/lib/elizaos/renderer-server.mjs
    usr/local/lib/elizaos/runtime-env
    usr/local/lib/elizaos/start-elizaos-agent-user
    usr/local/lib/elizaos/start-elizaos-browser-user
    usr/local/lib/elizaos/start-elizaos-pill-user
    usr/local/lib/elizaos/start-elizaos-renderer-user
    usr/local/lib/elizaos/start-milady-user
    usr/local/lib/elizaos/update-health-check
    usr/local/lib/elizaos/update-manager
    usr/local/lib/persistent-storage/on-activated-hooks/MiladyData/10-clean-runtime-state
    usr/local/lib/persistent-storage/on-activated-hooks/MiladyData/20-restart-milady
    usr/local/lib/persistent-storage/on-deactivated-hooks/MiladyData/20-restart-milady
    usr/local/lib/tails-boot-device-can-have-persistence
    usr/share/applications/milady.desktop
    usr/share/applications/org.boum.tails.PersistentStorage.desktop.in
    usr/share/pixmaps/elizaos-persistent-storage.svg
    usr/share/tails/persistent-storage/features_view.ui.in
    usr/share/tails/persistent-storage/locked_view.ui.in
    usr/share/tails/persistent-storage/passphrase_view.ui.in
    usr/share/tails/persistent-storage/style.css
    usr/share/tails/persistent-storage/welcome_view.ui.in
    usr/share/tails/persistent-storage/window.ui.in
    usr/share/whisperback/whisperback.ui.in
)

for rel in "${runtime_files[@]}"; do
    sync_file "${rel}"
done

copy_perl_module usr/src/iuk/lib/Tails/IUK/Frontend.pm Tails/IUK/Frontend.pm
copy_perl_module usr/src/iuk/lib/Tails/IUK/Install.pm Tails/IUK/Install.pm
copy_perl_module usr/src/perl5lib/lib/Tails/RunningSystem.pm Tails/RunningSystem.pm

run_root rm -rf "${CHROOT}/usr/share/elizaos/milady-app"
run_root mkdir -p "${CHROOT}/usr/share/elizaos"
run_root rsync -a --delete --chown=root:root "${APP_STAGE}/" \
    "${CHROOT}/usr/share/elizaos/milady-app/"
run_root chroot "${CHROOT}" /bin/sh -s < "${ROOT}/tails/config/chroot_local-hooks/9100-install-milady"
run_root chroot "${CHROOT}" /bin/sh -s < "${ROOT}/tails/config/chroot_local-hooks/99-zzzzzz_permissions"

echo "Synced elizaOS runtime overlay into ${CHROOT}"
