#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 NubsCarson and contributors
#
# Build the Phase 0 QEMU base image at vm/disk-base.qcow2.
#
# Approach: download the latest Debian sid generic-cloud qcow2, then use
# virt-customize to install our packages and overlay /etc files. This is
# faster, more reproducible, and less brittle than mmdebstrap-from-scratch
# for a development harness. (Phase 1's live ISO uses live-build separately.)
#
# Idempotent: re-running rebuilds from scratch. Cache the upstream image at
# vm/disk-base/.cache/upstream.qcow2 to skip the download on the next run.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$repo_root/.." && pwd)"

cd "$repo_root"

# shellcheck disable=SC1091
source vm/disk-base/mmdebstrap.recipe

cache_dir="vm/disk-base/.cache"
upstream_qcow2="$cache_dir/upstream.qcow2"
output_qcow2="vm/disk-base.qcow2"
overlay_dir="vm/disk-base/overlay"

mkdir -p "$cache_dir"

# --- Step 1: fetch upstream image (once, cached) ---
if [ ! -f "$upstream_qcow2" ]; then
    echo "==> downloading Debian sid cloud image"
    curl -fL --output "$upstream_qcow2.tmp" "$DEBIAN_SID_IMAGE_URL"
    mv "$upstream_qcow2.tmp" "$upstream_qcow2"
    echo "==> upstream image cached at $upstream_qcow2"
else
    echo "==> using cached upstream image at $upstream_qcow2"
fi

# --- Step 2: grow + customize ---
# `qemu-img resize` only grows the qcow2 *envelope*; the partition table and
# the filesystem inside still think they're 2 GB. virt-resize is the
# canonical tool that grows the partition and resizes the ext4 inside.
# We always rebuild the output from the cached upstream so the resize is
# reproducible (virt-resize is one-shot src → dst).
echo "==> sizing $output_qcow2 to 16G with virt-resize --expand"
rm -f "$output_qcow2"
qemu-img create -f qcow2 -o preallocation=metadata "$output_qcow2" 16G > /dev/null
sudo virt-resize --expand /dev/sda1 "$upstream_qcow2" "$output_qcow2"

# Build the package list as virt-customize --install args.
install_arg="$(IFS=,; echo "${VM_PACKAGES[*]}")"

# --- Per-host SSH keypair for the test harness ---
# Generate once; the public half goes into the qcow2's authorized_keys, the
# private half stays under `vm/.ssh/` (gitignored). See vm/.ssh/README.md.
ssh_dir="vm/.ssh"
ssh_priv="$ssh_dir/usbeliza_dev_ed25519"
ssh_pub="$ssh_dir/usbeliza_dev_ed25519.pub"
mkdir -p "$ssh_dir"
if [ ! -f "$ssh_priv" ]; then
    ssh-keygen -t ed25519 -N '' -f "$ssh_priv" -C 'usbeliza-dev@host'
    chmod 600 "$ssh_priv"
fi

echo "==> virt-customize: install packages, copy overlay, set up eliza user"
sudo virt-customize -a "$output_qcow2" \
    --update \
    --install "$install_arg" \
    --copy-in "$overlay_dir/etc/sway:/etc" \
    --copy-in "$overlay_dir/etc/systemd/system/elizad-session.service:/etc/systemd/system" \
    --copy-in "$overlay_dir/etc/systemd/system/elizad-session-interactive.service:/etc/systemd/system" \
    --copy-in "$overlay_dir/etc/systemd/system/eliza-agent.service:/etc/systemd/system" \
    --copy-in "$overlay_dir/etc/systemd/system/usbeliza-input-listener.service:/etc/systemd/system" \
    --copy-in "$overlay_dir/etc/systemd/system/ollama.service.d:/etc/systemd/system" \
    --copy-in "$overlay_dir/usr/local/bin/usbeliza-input-listener:/usr/local/bin" \
    --run-command 'useradd --create-home --shell /bin/bash --uid 1000 eliza || true' \
    --run-command 'echo "eliza ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/eliza' \
    --run-command 'chmod 440 /etc/sudoers.d/eliza' \
    --run-command 'install -d -o eliza -g eliza -m 700 /home/eliza/.ssh' \
    --copy-in "$ssh_pub:/home/eliza/.ssh" \
    --run-command "mv /home/eliza/.ssh/$(basename "$ssh_pub") /home/eliza/.ssh/authorized_keys" \
    --run-command 'chown eliza:eliza /home/eliza/.ssh/authorized_keys' \
    --run-command 'chmod 600 /home/eliza/.ssh/authorized_keys' \
    --run-command 'chmod +x /usr/local/bin/usbeliza-input-listener' \
    --run-command 'systemctl set-default graphical.target' \
    --run-command 'systemctl enable elizad-session.service' \
    --run-command 'systemctl enable eliza-agent.service' \
    --run-command 'systemctl enable usbeliza-input-listener.service' \
    --run-command 'systemctl enable ssh' \
    --run-command 'systemctl mask getty@tty1.service || true' \
    --run-command 'systemctl disable getty@tty1.service || true' \
    --run-command 'systemctl mask systemd-networkd-wait-online.service NetworkManager-wait-online.service systemd-networkd.service 2>&1 | head -5' \
    --run-command 'usermod -aG video,render,input eliza || true' \
    --run-command 'echo usbeliza > /etc/hostname' \
    --run-command 'sed -i "s/^127.0.1.1.*/127.0.1.1 usbeliza/" /etc/hosts; grep -q "127.0.1.1 usbeliza" /etc/hosts || echo "127.0.1.1 usbeliza" >> /etc/hosts' \
    --run-command 'ssh-keygen -A' \
    --run-command 'mkdir -p /run/eliza && chown eliza:eliza /run/eliza && chmod 0750 /run/eliza' \
    --truncate /etc/machine-id

# --- Configure dracut to be portable (hostonly=no) ---
# The Debian sid cloud image uses dracut for initramfs. Default config is
# `hostonly=yes` which restricts the initrd to modules currently loaded —
# fine for the cloud, but breaks the moment we want this qcow2 to also
# boot a fuller kernel or different hardware (live ISO Phase 1). With
# hostonly=no, dracut pulls all available modules into the initrd.
#
# We deliberately keep the cloud kernel (`linux-image-cloud-amd64`) — it
# boots reliably in QEMU and is what the live ISO will ship. Attempting
# to swap in the full `linux-image-amd64` previously caused boot hangs in
# this Debian sid build because of dracut hostonly + module mismatch.
# DRM rendering for the QEMU GUI goes through wlroots' headless backend
# (we capture frames with grim and display them on the host instead of
# relying on virtio-gpu DRM passthrough).
echo "==> virt-customize: portable dracut config + regenerate initramfs"
sudo virt-customize -a "$output_qcow2" \
    --run-command 'mkdir -p /etc/dracut.conf.d' \
    --run-command 'printf "%s\n" "hostonly=\"no\"" "hostonly_cmdline=\"no\"" > /etc/dracut.conf.d/10-usbeliza.conf' \
    --run-command 'dracut --regenerate-all -f 2>&1 | tail -3' \
    --run-command 'update-grub 2>&1 | tail -3'

# --- Eliza theming: Plymouth boot splash + branded GRUB ---
echo "==> virt-customize: install Plymouth + apply usbeliza theme + GRUB branding"
sudo virt-customize -a "$output_qcow2" \
    --install 'plymouth,plymouth-themes,plymouth-label' \
    --copy-in "$overlay_dir/usr/share/plymouth/themes/usbeliza:/usr/share/plymouth/themes" \
    --copy-in "$overlay_dir/etc/issue:/etc" \
    --copy-in "$overlay_dir/etc/default/grub.d/usbeliza.cfg:/etc/default/grub.d" \
    --run-command 'plymouth-set-default-theme usbeliza --rebuild-initrd' \
    --run-command 'update-grub || true'

# --- Ollama: install the daemon + pull the bundled model ---
# Done as a separate virt-customize pass so the install script's stdout is
# clean from the apt logs above, and so a re-run (cache hit) skips this
# pass via the shell test inside the run-command.
echo "==> virt-customize: install Ollama + pull ${OLLAMA_MODELS[*]}"
sudo virt-customize -a "$output_qcow2" \
    --run-command "command -v ollama || curl -fsSL ${OLLAMA_INSTALL_URL} | sh" \
    --run-command "systemctl enable ollama"

# --- Bun: install the Bun runtime that hosts eliza-agent ---
# Bun isn't in Debian repos. The upstream installer supports BUN_INSTALL
# to drop binaries under a specific prefix; using /usr/local installs
# /usr/local/bin/bun directly, system-wide. (Earlier attempts at
# `su -l eliza -c ...` failed silently inside virt-customize's libguestfs
# appliance because the eliza login environment isn't properly set up
# there.)
echo "==> virt-customize: install Bun system-wide via the upstream installer"
sudo virt-customize -a "$output_qcow2" \
    --run-command 'rm -f /usr/local/bin/bun /usr/local/bin/bunx' \
    --run-command 'BUN_INSTALL=/usr/local HOME=/root bash -c "curl -fsSL https://bun.com/install | bash" || (curl -fsSL https://bun.com/install -o /tmp/bun-install.sh && BUN_INSTALL=/usr/local HOME=/root bash /tmp/bun-install.sh && rm -f /tmp/bun-install.sh)' \
    --run-command 'chmod +x /usr/local/bin/bun /usr/local/bin/bunx 2>/dev/null || true' \
    --run-command 'test -x /usr/local/bin/bun || (echo "ERROR: bun did not install to /usr/local/bin" >&2; exit 1)'

# Pulling the model needs ollama serving; do it in a single transient
# virt-customize run so the binary is already on disk and the systemd unit
# is enabled (previous pass), then start it manually inside the appliance,
# pull, and shut down cleanly.
for model in "${OLLAMA_MODELS[@]}"; do
    echo "==> virt-customize: pulling Ollama model ${model}"
    sudo virt-customize -a "$output_qcow2" \
        --run-command "
            install -d -o ollama -g ollama /usr/share/ollama/.ollama
            HOME=/usr/share/ollama OLLAMA_HOST=127.0.0.1:11434 \
                /usr/local/bin/ollama serve >/var/log/ollama-build.log 2>&1 &
            ollama_pid=\$!
            for i in \$(seq 1 30); do
                curl -sf http://127.0.0.1:11434/api/version >/dev/null 2>&1 && break
                sleep 1
            done
            HOME=/usr/share/ollama OLLAMA_HOST=127.0.0.1:11434 \
                /usr/local/bin/ollama pull ${model}
            kill \$ollama_pid 2>/dev/null
            wait \$ollama_pid 2>/dev/null || true
        "
done

echo "==> base image built: $output_qcow2"
ls -lh "$output_qcow2"
