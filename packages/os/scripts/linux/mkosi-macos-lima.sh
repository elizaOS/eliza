#!/usr/bin/env bash
# Explicit Apple Silicon bootstrap for canonical mkosi work in a native Linux VM.
set -euo pipefail

instance="${ELIZAOS_LIMA_INSTANCE:-elizaos-mkosi}"
vm_type="${ELIZAOS_LIMA_VM_TYPE:-vz}"
guest_out="${ELIZAOS_LIMA_GUEST_OUT:-/var/tmp/elizaos-mkosi-arm64}"
guest_evidence="${ELIZAOS_LIMA_GUEST_EVIDENCE:-/var/tmp/elizaos-evidence}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
variant_dir="$(cd "${script_dir}/../../linux/elizaos" && pwd)"
repo_root="$(git -C "$variant_dir" rev-parse --show-toplevel)"
guest_builder="${script_dir}/mkosi-linux-build.py"

case "$instance" in
    *[!A-Za-z0-9._-]*|'')
        echo "[mkosi-macos-lima] invalid ELIZAOS_LIMA_INSTANCE: $instance" >&2
        exit 64
        ;;
esac
case "$vm_type" in
    vz) mount_type=virtiofs ;;
    qemu) mount_type=9p ;;
    *)
        echo "[mkosi-macos-lima] ELIZAOS_LIMA_VM_TYPE must be vz or qemu" >&2
        exit 64
        ;;
esac
for guest_path in "$guest_out" "$guest_evidence"; do
    case "$guest_path/" in
        *"/../"*|*"/./"*|*"//"*)
            echo "[mkosi-macos-lima] guest output paths cannot contain relative or empty components" >&2
            exit 64 ;;
        /var/tmp/*/) ;;
        *)
            echo "[mkosi-macos-lima] guest output paths must remain beneath /var/tmp" >&2
            exit 64 ;;
    esac
done

usage() {
    cat <<EOF
Usage: ${0##*/} COMMAND [ARG]

Commands:
  doctor            Inspect the Mac without changing it.
  start             Create/start the named Debian 13 VZ VM (downloads a VM image).
  provision         Install the reviewed Debian build/QEMU package set in the VM.
  preflight-arm64   Run the canonical assembly preflight without building.
  build-arm64       Build a development arm64 disk and JSON assembly evidence.
  shell             Open a shell in the VM.
  export DIR        Copy guest output/evidence into an existing empty host DIR.
  commands          Print the exact manual command sequence without changing state.

No command installs Homebrew software, deletes a VM, or overwrites a nonempty
export directory. Install Lima separately only after reviewing the printed
Homebrew bottle metadata and command.
EOF
}

require_macos_arm64() {
    [ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || {
        echo "[mkosi-macos-lima] this harness requires Apple Silicon macOS" >&2
        exit 1
    }
}

require_lima() {
    command -v limactl >/dev/null 2>&1 || {
        echo "[mkosi-macos-lima] Lima is absent; review then run: brew install lima" >&2
        exit 1
    }
}

doctor() {
    require_macos_arm64
    echo "host.os=$(sw_vers -productVersion)"
    echo "host.arch=$(uname -m)"
    echo "host.cpus=$(sysctl -n hw.ncpu)"
    echo "host.memory_bytes=$(sysctl -n hw.memsize)"
    echo "host.available_bytes=$(df -k "$repo_root" | awk 'NR == 2 { print $4 * 1024 }')"
    echo "repo=$repo_root"
    if command -v limactl >/dev/null 2>&1; then
        echo "lima=$(command -v limactl)"
        limactl --version
        limactl list --format 'vm={{.Name}} status={{.Status}} arch={{.Arch}} type={{.VMType}}'
    else
        echo "lima=missing"
        if command -v brew >/dev/null 2>&1; then
            echo "install.review=brew info lima"
            echo "install.command=brew install lima"
        else
            echo "homebrew=missing"
        fi
        return 1
    fi
}

start_vm() {
    require_macos_arm64
    require_lima
    existing_instances="$(limactl list --format '{{.Name}}')"
    for existing_instance in $existing_instances; do
        if [ "$existing_instance" != "$instance" ]; then
            echo "[mkosi-macos-lima] refusing a second VM while '${existing_instance}' exists" >&2
            echo "[mkosi-macos-lima] inspect it with: limactl list && limactl shell ${existing_instance}" >&2
            exit 1
        fi
    done
    available_kib="$(df -k "$repo_root" | awk 'NR == 2 { print $4 }')"
    minimum_kib=$((80 * 1024 * 1024))
    [ "$available_kib" -ge "$minimum_kib" ] || {
        echo "[mkosi-macos-lima] at least 80 GiB host free space is required before VM creation" >&2
        exit 1
    }
    # template:debian-13 pins the guest distribution major. VZ cannot emulate a foreign
    # machine architecture, so the VM is intentionally native aarch64.
    limactl start \
        --name="$instance" \
        --vm-type="$vm_type" \
        --arch=aarch64 \
        --cpus=8 \
        --memory=12 \
        --disk=96 \
        --containerd=none \
        --mount-type="$mount_type" \
        --mount-only="$repo_root" \
        template:debian-13
}

provision_vm() {
    require_lima
    limactl shell "$instance" sudo env DEBIAN_FRONTEND=noninteractive \
        apt-get update
    limactl shell "$instance" sudo env DEBIAN_FRONTEND=noninteractive \
        apt-get install -y --no-install-recommends \
        binfmt-support ca-certificates debootstrap dosfstools e2fsprogs git \
        mkosi mtools ovmf python3 python3-cryptography \
        qemu-efi-aarch64 qemu-efi-riscv64 qemu-system-arm qemu-system-misc \
        qemu-system-x86 qemu-user-static rsync swtpm systemd-boot \
        systemd-container systemd-repart zstd
    limactl shell "$instance" sudo update-binfmts --enable qemu-x86_64
    limactl shell "$instance" sudo update-binfmts --enable qemu-riscv64
    limactl shell "$instance" bash -lc \
        'mkosi --version && systemd-repart --version | head -n 1 && uname -a'
}

preflight_arm64() {
    require_lima
    limactl shell "$instance" sudo python3 "$guest_builder" \
        --architecture arm64 \
        --allow-dirty-development \
        --output-dir "$guest_out" \
        --evidence "${guest_evidence}/arm64-preflight.json" \
        --preflight-only
}

build_arm64() {
    require_lima
    limactl shell "$instance" sudo python3 "$guest_builder" \
        --architecture arm64 \
        --allow-dirty-development \
        --output-dir "$guest_out" \
        --evidence "${guest_evidence}/arm64-build.json"
}

export_results() {
    destination="${1:-}"
    [ -n "$destination" ] || {
        echo "[mkosi-macos-lima] export requires a destination directory" >&2
        exit 64
    }
    [ -d "$destination" ] && [ -z "$(find "$destination" -mindepth 1 -maxdepth 1 -print -quit)" ] || {
        echo "[mkosi-macos-lima] export destination must exist and be empty: $destination" >&2
        exit 1
    }
    require_lima
    destination="$(cd "$destination" && pwd)"
    limactl copy -r "${instance}:${guest_out}" "${instance}:${guest_evidence}" "$destination/"
}

print_commands() {
    cat <<EOF
brew info lima
brew install lima
${0} start
${0} provision
${0} preflight-arm64
${0} build-arm64
mkdir -p /path/to/empty/export
${0} export /path/to/empty/export
EOF
}

case "${1:-}" in
    doctor) doctor ;;
    start) start_vm ;;
    provision) provision_vm ;;
    preflight-arm64) preflight_arm64 ;;
    build-arm64) build_arm64 ;;
    shell) require_lima; exec limactl shell "$instance" ;;
    export) export_results "${2:-}" ;;
    commands) print_commands ;;
    -h|--help|help|'') usage ;;
    *) echo "[mkosi-macos-lima] unknown command: $1" >&2; usage >&2; exit 64 ;;
esac
