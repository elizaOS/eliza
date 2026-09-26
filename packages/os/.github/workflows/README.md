# OS workflow definitions

These definitions came from the standalone OS repository. GitHub Actions only
runs workflows in the repository-root [workflow directory](../../../../.github/workflows).
OS validation runs from reusable [os.yml](../../../../.github/workflows/os.yml),
required by canonical [CI](../../../../.github/workflows/ci.yml) under Develop Full.
PR Static Smoke owns pre-merge static validation. The former nested release-validation
workflow is consolidated into OS CI, including Android wrapper refusals, the
checked-in release plan, and USB desktop/mobile browser flows.
Debian packaging runs from [build-debian-package.yml](../../../../.github/workflows/build-debian-package.yml).
Android tool checksum refresh is manually dispatched through
[update-vendor-checksums.yml](../../../../.github/workflows/update-vendor-checksums.yml).
Pinned application sources are updated through manual
[update-eliza-source-lock.yml](../../../../.github/workflows/update-eliza-source-lock.yml).
Native RISC-V builds and QEMU checks are manually dispatched through
[riscv64-smoke.yml](../../../../.github/workflows/riscv64-smoke.yml).
Desktop setup packages are built by reusable or manually dispatched
[release-elizaos-setup.yml](../../../../.github/workflows/release-elizaos-setup.yml).
USB packages use [release-usb-installer.yml](../../../../.github/workflows/release-usb-installer.yml),
with shared [raw-writer VM qualification](../../../../.github/workflows/os-usb-raw-qualification.yml)
for both CI and release packaging.
Signed APT repository publication uses
[publish-apt-repo.yml](../../../../.github/workflows/publish-apt-repo.yml).
Authenticated Android update indexes use
[publish-aosp-update-manifest.yml](../../../../.github/workflows/publish-aosp-update-manifest.yml).
Canonical Linux image assembly, USB boot/persistence qualification, and signing use
[build-linux-mkosi.yml](../../../../.github/workflows/build-linux-mkosi.yml).
Manual manifest checksum recovery uses
[update-os-release-manifest.yml](../../../../.github/workflows/update-os-release-manifest.yml),
which proposes a draft PR against an explicitly bound develop commit and release inventory.
AOSP/Cuttlefish builds use [elizaos-cuttlefish.yml](../../../../.github/workflows/elizaos-cuttlefish.yml),
with retained application sources and an explicitly enabled native KVM fleet.
The remaining full-release and homepage definitions still require migration.
