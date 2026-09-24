#!/usr/bin/env bash
# Static validation for the canonical mkosi workstation definition.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MKOSI_DIR="${ROOT}/mkosi"
fail=0

bad() { echo "[mkosi-lint] FAIL: $*" >&2; fail=1; }
ok() { echo "[mkosi-lint] ok:   $*"; }
require_file() { [ -f "$1" ] && ok "present ${1#"${ROOT}/"}" || bad "missing ${1#"${ROOT}/"}"; }
require_text() {
    local needle="$1" file="$2"
    grep -Fq -- "$needle" "$file" || bad "${file#"${ROOT}/"}: missing '$needle'"
}
reject_text() {
    local pattern="$1" path="$2"
    if grep -ERin --include='*.conf' --include='*.service' --include='*.target' \
        --include='*.preset' --include='*.chroot' -- "$pattern" "$path" >/dev/null 2>&1; then
        bad "${path#"${ROOT}/"}: forbidden pattern '$pattern'"
    fi
}

require_file "${MKOSI_DIR}/mkosi.conf"
require_file "${MKOSI_DIR}/mkosi.postinst.chroot"
[ -x "${MKOSI_DIR}/mkosi.postinst.chroot" ] || bad "mkosi.postinst.chroot is not executable"
[ ! -e "${MKOSI_DIR}/mkosi.postinst" ] || bad "unsuffixed mkosi.postinst would run on the host"
[ ! -e "${MKOSI_DIR}/mkosi.finalize" ] || bad "legacy pre-output finalize script is present"
[ ! -e "${MKOSI_DIR}/mkosi.skeleton" ] || bad "mkosi.skeleton must not import the live-build tree"

for arch in amd64 arm64 riscv64; do
    require_file "${MKOSI_DIR}/mkosi.conf.d/10-arch-${arch}.conf"
done

require_text 'MinimumVersion=25.3' "${MKOSI_DIR}/mkosi.conf"
require_text 'Distribution=debian' "${MKOSI_DIR}/mkosi.conf"
require_text 'Release=trixie' "${MKOSI_DIR}/mkosi.conf"
require_text 'Format=disk' "${MKOSI_DIR}/mkosi.conf"
if grep -Eq '^[[:space:]]*ToolsTree=' "${MKOSI_DIR}/mkosi.conf"; then
    bad "native multiarch builds must use host tools; mkosi 25.3 default tools tree pulls grub-pc-bin on arm64"
fi
require_text 'BuildSources=../..' "${MKOSI_DIR}/mkosi.conf"
require_text 'Checksum=yes' "${MKOSI_DIR}/mkosi.conf"
require_text '    python3-cryptography' "${MKOSI_DIR}/mkosi.conf"
require_text '    gdisk' "${MKOSI_DIR}/mkosi.conf"
require_text '    e2fsprogs' "${MKOSI_DIR}/mkosi.conf"
require_text '    btrfs-progs' "${MKOSI_DIR}/mkosi.conf"
require_text '    ntfs-3g' "${MKOSI_DIR}/mkosi.conf"
require_text '    zstd' "${MKOSI_DIR}/mkosi.conf"
for package in gdm3 gnome-core gnome-initial-setup speech-dispatcher-espeak-ng xdg-desktop-portal-gnome; do
    require_text "    ${package}" "${MKOSI_DIR}/mkosi.conf"
done
require_text 'ShimBootloader=signed' "${MKOSI_DIR}/mkosi.conf.d/10-arch-amd64.conf"
require_text 'BiosBootloader=grub' "${MKOSI_DIR}/mkosi.conf.d/10-arch-amd64.conf"
require_text 'ShimBootloader=signed' "${MKOSI_DIR}/mkosi.conf.d/10-arch-arm64.conf"
require_text 'KernelCommandLine=console=tty0 console=ttyS0,115200n8' \
    "${MKOSI_DIR}/mkosi.conf.d/10-arch-amd64.conf"
require_text 'KernelCommandLine=console=tty0 console=ttyAMA0,115200n8' \
    "${MKOSI_DIR}/mkosi.conf.d/10-arch-arm64.conf"
require_text 'KernelCommandLine=console=tty0 console=ttyS0,115200n8' \
    "${MKOSI_DIR}/mkosi.conf.d/10-arch-riscv64.conf"
if grep -Fq 'ShimBootloader=signed' "${MKOSI_DIR}/mkosi.conf.d/10-arch-riscv64.conf"; then
    bad "riscv64 must not claim Debian signed-shim support"
fi

for spec in 00-esp 05-bios 10-root 20-recovery 30-home; do
    require_file "${MKOSI_DIR}/mkosi.repart/${spec}.conf"
done
require_text 'Type=esp' "${MKOSI_DIR}/mkosi.repart/00-esp.conf"
require_text 'Type=root' "${MKOSI_DIR}/mkosi.repart/10-root.conf"
require_text 'SizeMinBytes=16G' "${MKOSI_DIR}/mkosi.repart/10-root.conf"
require_text 'SizeMaxBytes=16G' "${MKOSI_DIR}/mkosi.repart/10-root.conf"
require_text 'Label=elizaos-recovery' "${MKOSI_DIR}/mkosi.repart/20-recovery.conf"
require_text 'Type=linux-generic' "${MKOSI_DIR}/mkosi.repart/20-recovery.conf"
require_text 'Type=home' "${MKOSI_DIR}/mkosi.repart/30-home.conf"
require_text 'GrowFileSystem=yes' "${MKOSI_DIR}/mkosi.repart/30-home.conf"
last_repart="$(find "${MKOSI_DIR}/mkosi.repart" -type f -name '*.conf' -print | sort | tail -n 1)"
[ "$last_repart" = "${MKOSI_DIR}/mkosi.repart/30-home.conf" ] || bad "growable home must be the last partition definition"
require_file "${MKOSI_DIR}/mkosi.extra/usr/lib/systemd/system/elizaos-grow-persistent.service"
require_file "${MKOSI_DIR}/mkosi.extra/usr/libexec/elizaos-grow-persistent"
[ -x "${MKOSI_DIR}/mkosi.extra/usr/libexec/elizaos-grow-persistent" ] || bad "persistent grow helper is not executable"
require_text 'ConditionKernelCommandLine=!elizaos.recovery=1' \
    "${MKOSI_DIR}/mkosi.extra/usr/lib/systemd/system/elizaos-grow-persistent.service"
require_text 'systemd-repart --dry-run=no --empty=allow --include-partitions=home' \
    "${MKOSI_DIR}/mkosi.extra/usr/libexec/elizaos-grow-persistent"
require_text '($1 * 512) + $2' \
    "${MKOSI_DIR}/mkosi.extra/usr/libexec/elizaos-grow-persistent"

for unit in elizaos-session.target elizaos-agent.service elizaos-desktop.service; do
    require_file "${MKOSI_DIR}/mkosi.extra/usr/lib/systemd/user/${unit}"
done
require_text 'ConditionPathIsExecutable=/opt/elizaos/bin/eliza-agent' \
    "${MKOSI_DIR}/mkosi.extra/usr/lib/systemd/user/elizaos-agent.service"
require_text 'ConditionPathIsExecutable=/opt/elizaos/bin/eliza-desktop' \
    "${MKOSI_DIR}/mkosi.extra/usr/lib/systemd/user/elizaos-desktop.service"
require_text 'ExecStart=/usr/bin/eliza-desktop --tray --overlay' \
    "${MKOSI_DIR}/mkosi.extra/usr/lib/systemd/user/elizaos-desktop.service"
for wrapper in eliza-agent eliza-desktop eliza-doctor; do
    require_file "${MKOSI_DIR}/mkosi.extra/usr/bin/${wrapper}"
    [ -x "${MKOSI_DIR}/mkosi.extra/usr/bin/${wrapper}" ] || bad "${wrapper} wrapper is not executable"
done
require_file "${MKOSI_DIR}/mkosi.extra/usr/lib/systemd/user-preset/80-elizaos.preset"
require_text 'enable elizaos-session.target' \
    "${MKOSI_DIR}/mkosi.extra/usr/lib/systemd/user-preset/80-elizaos.preset"

require_file "${MKOSI_DIR}/mkosi.extra/etc/grub.d/42_elizaos_recovery"
[ -x "${MKOSI_DIR}/mkosi.extra/etc/grub.d/42_elizaos_recovery" ] || bad "recovery GRUB generator is not executable"
require_text 'systemd.unit=rescue.target' "${MKOSI_DIR}/mkosi.extra/etc/grub.d/42_elizaos_recovery"
require_text '--hotkey=r' "${MKOSI_DIR}/mkosi.extra/etc/grub.d/42_elizaos_recovery"
recovery_verify_unit="${MKOSI_DIR}/mkosi.extra/usr/lib/systemd/system/elizaos-recovery-verify.service"
recovery_verify_helper="${MKOSI_DIR}/mkosi.extra/usr/libexec/elizaos-recovery-verify"
require_file "$recovery_verify_unit"
require_file "$recovery_verify_helper"
[ -x "$recovery_verify_helper" ] || bad "recovery boundary verifier is not executable"
require_text 'ConditionKernelCommandLine=elizaos.recovery=1' "$recovery_verify_unit"
require_text 'WantedBy=rescue.target' "$recovery_verify_unit"
require_text 'eliza-control-broker.service eliza-control-broker.socket' "$recovery_verify_helper"
require_text "--state=active,activating,reloading,deactivating 'user@*.service'" \
    "$recovery_verify_helper"
require_text '/proc/[0-9]*/cmdline' "$recovery_verify_helper"
require_text 'elizaOS recovery boundary verified: Eliza agent and privileged broker unavailable' \
    "$recovery_verify_helper"
initial_setup_profile="${MKOSI_DIR}/mkosi.extra/usr/share/dconf/profile/gnome-initial-setup"
branding_defaults="${MKOSI_DIR}/mkosi.extra/usr/share/glib-2.0/schemas/90_elizaos-branding.gschema.override"
icon_theme="${MKOSI_DIR}/mkosi.extra/usr/share/icons/elizaOS/index.theme"
require_file "$initial_setup_profile"
require_file "$branding_defaults"
require_file "$icon_theme"
require_text 'system-db:local' "$initial_setup_profile"
require_text 'elizaos-blue.svg' "$branding_defaults"
require_text "icon-theme='elizaOS'" "$branding_defaults"
require_text 'Inherits=Adwaita,hicolor' "$icon_theme"
require_text 'logo_blue_nobg.svg' "${MKOSI_DIR}/mkosi.postinst.chroot"
require_text 'glib-compile-schemas /usr/share/glib-2.0/schemas' "${MKOSI_DIR}/mkosi.postinst.chroot"
require_text 'gtk-update-icon-cache --force /usr/share/icons/elizaOS' "${MKOSI_DIR}/mkosi.postinst.chroot"
require_text 'systemctl set-default graphical.target' "${MKOSI_DIR}/mkosi.postinst.chroot"
require_text 'systemctl --global enable elizaos-session.target' "${MKOSI_DIR}/mkosi.postinst.chroot"
require_text 'systemctl enable eliza-control-broker.socket' "${MKOSI_DIR}/mkosi.postinst.chroot"
require_text 'systemctl enable elizaos-grow-persistent.service' "${MKOSI_DIR}/mkosi.postinst.chroot"
require_text 'systemctl enable elizaos-recovery-verify.service' "${MKOSI_DIR}/mkosi.postinst.chroot"
require_text 'control_source="${source_root}/control"' "${MKOSI_DIR}/mkosi.postinst.chroot"
require_text 'eliza_control/installer.py' "${MKOSI_DIR}/mkosi.postinst.chroot"
require_text 'eliza_control/provision.py' "${MKOSI_DIR}/mkosi.postinst.chroot"
require_text 'systemd/eliza-control-provision.service' "${MKOSI_DIR}/mkosi.postinst.chroot"
require_text 'protocol/installer-execution.schema.json' "${MKOSI_DIR}/mkosi.postinst.chroot"
require_text '/etc/sudoers.d/010-elizaos-agent' "${MKOSI_DIR}/mkosi.postinst.chroot"
require_text 'ELIZAOS_BUILD_MODE=development' "${MKOSI_DIR}/mkosi.conf"
require_text 'desktop-artifact-manifest.json' "${MKOSI_DIR}/mkosi.postinst.chroot"
require_text 'ELIZAOS_DESKTOP_SIGNING_PUBLIC_KEY_SPKI_SHA256' "${MKOSI_DIR}/mkosi.postinst.chroot"
require_text 'verify-desktop-artifact.py' "${MKOSI_DIR}/mkosi.postinst.chroot"
verifier="${ROOT}/scripts/verify-desktop-artifact.py"
require_file "$verifier"
require_text 'Ed25519PublicKey' "$verifier"
require_text 'public_key.verify(signature' "$verifier"
require_text 'canonical base64 Ed25519' "$verifier"
require_text 'manifest fields do not match schema v1' "$verifier"
require_text 'manifest is absent or is a symlink' "$verifier"
require_text 'manifest signature is invalid' "$verifier"
require_text 'desktop-artifact-manifest.json.sig' "$verifier"
require_text 'archive must use the .tar.zst contract' "$verifier"
require_text 'archive signature filename is invalid' "$verifier"
require_text 'native shell architecture does not match image' "$verifier"
require_text 'filter="data"' "$verifier"
require_text 'archive changed during extraction' "$verifier"
require_text 'archive digest does not match manifest' "$verifier"
require_text 'entrypoints must be archive-relative bin/* paths' "$verifier"
require_text '--extract-to /opt/elizaos' "${MKOSI_DIR}/mkosi.postinst.chroot"
for qualification_script in mkosi-linux-build.py mkosi-qemu-qualify.py mkosi-persistence-qualify.py mkosi-reproducibility-qualify.py generate-mkosi-sbom.sh; do
    require_file "${ROOT}/scripts/${qualification_script}"
    [ -x "${ROOT}/scripts/${qualification_script}" ] || bad "${qualification_script} is not executable"
done
require_file "${ROOT}/scripts/mkosi-macos-lima.sh"
[ -x "${ROOT}/scripts/mkosi-macos-lima.sh" ] || bad "mkosi-macos-lima.sh is not executable"
require_text 'ELIZAOS_LIMA_VM_TYPE' "${ROOT}/scripts/mkosi-macos-lima.sh"
require_text '--arch=aarch64' "${ROOT}/scripts/mkosi-macos-lima.sh"
require_text '--mount-only="$repo_root"' "${ROOT}/scripts/mkosi-macos-lima.sh"
require_text '--allow-dirty-development' "${ROOT}/scripts/mkosi-macos-lima.sh"
if grep -Eq 'limactl (delete|remove)' "${ROOT}/scripts/mkosi-macos-lima.sh"; then
    bad "Mac Lima harness must not delete VMs"
fi
require_text 'mkosi_disk_assembly_only_no_boot_or_hardware_claim' \
    "${ROOT}/scripts/mkosi-linux-build.py"
require_text 'release builds require a dated snapshot.debian.org archive URL' \
    "${ROOT}/scripts/mkosi-linux-build.py"
require_text 'configurationSha256' "${ROOT}/scripts/mkosi-linux-build.py"
require_text '--extra-tree=' "${ROOT}/scripts/mkosi-linux-build.py"
require_text 'desktopArtifactInputs' "${ROOT}/scripts/mkosi-linux-build.py"
require_text '"profile": args.profile' "${ROOT}/scripts/mkosi-linux-build.py"
require_text 'source identity changed during mkosi build' "${ROOT}/scripts/mkosi-linux-build.py"
require_text 'mkosi configuration changed during build' "${ROOT}/scripts/mkosi-linux-build.py"
require_text 'desktop artifact inputs changed during mkosi build' "${ROOT}/scripts/mkosi-linux-build.py"
require_text 'qemu_graphical_target_only_no_login_agent_computer_control_or_hardware_claim' \
    "${ROOT}/scripts/mkosi-qemu-qualify.py"
require_text 'required boot markers' "${ROOT}/scripts/mkosi-qemu-qualify.py"
require_text '--bios cannot be combined with pflash firmware mode' \
    "${ROOT}/scripts/mkosi-qemu-qualify.py"
require_text 'choices=("usb", "virtio"), default="usb"' \
    "${ROOT}/scripts/mkosi-qemu-qualify.py"
require_text 'terminationReason' "${ROOT}/scripts/mkosi-qemu-qualify.py"
require_text '"firmwareMode": args.firmware_mode' "${ROOT}/scripts/mkosi-qemu-qualify.py"
require_text '"version": version_line' "${ROOT}/scripts/mkosi-qemu-qualify.py"
require_text 'virt,accel=hvf,gic-version=max' "${ROOT}/scripts/mkosi-qemu-qualify.py"
require_text 'Started gdm.service - GNOME Display Manager' "${ROOT}/scripts/mkosi-qemu-qualify.py"
require_text 'Reached target Graphical Interface' "${ROOT}/scripts/mkosi-qemu-qualify.py"
require_text 'choices=("graphical", "recovery")' "${ROOT}/scripts/mkosi-qemu-qualify.py"
require_text 'qemu_recovery_selection_and_service_unavailability_only' \
    "${ROOT}/scripts/mkosi-qemu-qualify.py"
require_text 'tempfile.NamedTemporaryFile' "${ROOT}/scripts/mkosi-qemu-qualify.py"
require_text 'os.link(temporary_path, path)' "${ROOT}/scripts/mkosi-qemu-qualify.py"
require_text 'recovery hotkey was never accepted' "${ROOT}/scripts/mkosi-qemu-qualify.py"
require_text 'two_boot_home_persistence' \
    "${ROOT}/scripts/mkosi-persistence-qualify.py"
require_text 'virtual USB expanded-byte readback digest mismatch' \
    "${ROOT}/scripts/mkosi-persistence-qualify.py"
require_text 'home sentinel did not survive the second boot' \
    "${ROOT}/scripts/mkosi-persistence-qualify.py"
require_text 'Reached target Graphical Interface' \
    "${ROOT}/scripts/mkosi-persistence-qualify.py"
require_text 'work image must not already exist' \
    "${ROOT}/scripts/mkosi-persistence-qualify.py"
require_text 'two_build_root_partition_reproducibility_only' \
    "${ROOT}/scripts/mkosi-reproducibility-qualify.py"
require_text 'expanded image does not match its compressed build artifact' \
    "${ROOT}/scripts/mkosi-reproducibility-qualify.py"
require_text 'isolated builds have different discoverable root partition geometry' \
    "${ROOT}/scripts/mkosi-reproducibility-qualify.py"
require_text 'discoverable root partition' \
    "${ROOT}/scripts/mkosi-reproducibility-qualify.py"
require_text 'diffoscope did not produce a regular report' \
    "${ROOT}/scripts/mkosi-reproducibility-qualify.py"
require_text 'all input and output paths must be distinct' \
    "${ROOT}/scripts/mkosi-reproducibility-qualify.py"
require_text 'document.get("returnCode") != 0' \
    "${ROOT}/scripts/mkosi-reproducibility-qualify.py"
require_text 'Secure Boot is unsupported on riscv64' "${ROOT}/mkosi/README.md"
require_text 'elizaos-system' "${ROOT}/scripts/generate-mkosi-sbom.sh"
require_text 'mount --read-only --options noload' \
    "${ROOT}/scripts/generate-mkosi-sbom.sh"
require_text 'document.packages.length === 0' \
    "${ROOT}/scripts/generate-mkosi-sbom.sh"
if grep -Fq '"-cpu", "max"' "${ROOT}/scripts/mkosi-qemu-qualify.py"; then
    bad "QEMU qualification must not force the TCG max CPU under KVM"
fi
for dropin in \
    "${MKOSI_DIR}/mkosi.extra/etc/systemd/system/eliza-control-broker.service.d/10-recovery.conf" \
    "${MKOSI_DIR}/mkosi.extra/etc/systemd/system/eliza-control-broker.socket.d/10-recovery.conf"; do
    require_file "$dropin"
    require_text 'ConditionKernelCommandLine=!elizaos.recovery=1' "$dropin"
done

# Canonical images must not regress to privacy/live/kiosk packages or embed a
# different runtime topology by architecture.
if grep -ERin --include='*.conf' '^[[:space:]]*(cage|seatd|tor|torsocks|macchanger|secure-delete)[[:space:]]*$' "${MKOSI_DIR}" >/dev/null 2>&1; then
    bad "retired live/privacy package appears in mkosi configuration"
fi
reject_text 'NOPASSWD|ExecStart=.*sudo' "${MKOSI_DIR}"
reject_text 'ExecStart=.*(elizaos-kiosk|start-kiosk|start-cage|xorg-kiosk|cage)' "${MKOSI_DIR}"
reject_text 'Autologin=yes|AutomaticLoginEnable=true' "${MKOSI_DIR}"
reject_text 'postgresql|node-undici|node-fetch' "${MKOSI_DIR}/mkosi.conf.d"

shopt -s nullglob
for file in "${MKOSI_DIR}/mkosi.conf" "${MKOSI_DIR}/mkosi.conf.d/"*.conf \
    "${MKOSI_DIR}/mkosi.profiles/"*/mkosi.conf "${MKOSI_DIR}/mkosi.repart/"*.conf; do
    grep -q '^\[[A-Za-z]' "$file" || bad "${file#"${ROOT}/"}: no INI section"
done

secure_packages="$(sed -n '/^Packages=/,$p' "${MKOSI_DIR}/mkosi.profiles/secure/mkosi.conf" | sed '/^#/d' | sed '/^[[:space:]]*$/d')"
secure_gui_packages="$(sed -n '/^Packages=/,$p' "${MKOSI_DIR}/mkosi.profiles/secure-gui/mkosi.conf" | sed '/^#/d' | sed '/^[[:space:]]*$/d')"
[ "$secure_packages" = "$secure_gui_packages" ] || bad "secure and secure-gui hardening package sets differ"

if command -v mkosi >/dev/null 2>&1; then
    for arch in x86-64 arm64 riscv64; do
        (cd "$MKOSI_DIR" && mkosi --architecture "$arch" summary >/dev/null) \
            || bad "mkosi summary failed for $arch"
    done
    ok "mkosi parsed all architecture configurations"
else
    echo "[mkosi-lint] skip: mkosi is unavailable; static checks only"
fi

if [ "$fail" -ne 0 ]; then
    echo "[mkosi-lint] FAILED" >&2
    exit 1
fi
echo "[mkosi-lint] PASS"
