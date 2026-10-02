#!/usr/bin/env bash
# GCE startup script for the Intel nested-virtualization Cuttlefish host.
# Runs as root on every boot; idempotent. Installs the Cuttlefish host
# packages from Google's android-cuttlefish Artifact Registry apt repository
# (https://github.com/google/android-cuttlefish), adds a `builder` user to the
# kvm/cvdnetwork/render groups, and reboots once so the kernel modules and
# udev rules load.
#
# A successful install proves only that the host packages installed. It does
# not prove that an eliza Cuttlefish image boots; that needs a built image
# and its own launch evidence.
set -euo pipefail

MARKER=/var/lib/aosp-builder/cuttlefish-host.done
KEYRING=/etc/apt/keyrings/android-cuttlefish.asc
LIST=/etc/apt/sources.list.d/android-cuttlefish.list
BUILDER_USER=builder

log() { printf 'cuttlefish-host-startup: %s\n' "$*"; }

if [[ -f "$MARKER" ]]; then
  if [[ -e /dev/kvm ]]; then
    log "already provisioned; /dev/kvm present"
  else
    log "WARNING: provisioned but /dev/kvm is missing; was the VM created with --enable-nested-virtualization on an Intel series?"
  fi
  exit 0
fi

if ! grep -Eq 'vmx' /proc/cpuinfo; then
  log "WARNING: no vmx CPU flag; nested virtualization is not enabled on this VM"
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl gnupg

install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://us-apt.pkg.dev/doc/repo-signing-key.gpg -o "$KEYRING.tmp"
log "Artifact Registry apt signing key fingerprints:"
gpg --show-keys --with-fingerprint --with-colons "$KEYRING.tmp" | awk -F: '$1=="fpr"{print "  " $10}'
mv "$KEYRING.tmp" "$KEYRING"
chmod 0644 "$KEYRING"
printf 'deb [signed-by=%s] https://us-apt.pkg.dev/projects/android-cuttlefish-artifacts android-cuttlefish main\n' \
  "$KEYRING" >"$LIST"

apt-get update
apt-get install -y cuttlefish-base cuttlefish-user

if ! id "$BUILDER_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$BUILDER_USER"
fi
usermod -aG kvm,cvdnetwork,render "$BUILDER_USER"

install -d -m 0755 "$(dirname "$MARKER")"
date -u +%Y-%m-%dT%H:%M:%SZ >"$MARKER"
log "installed; rebooting once to load kernel modules and udev rules"
systemctl reboot
