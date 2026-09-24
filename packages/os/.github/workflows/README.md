# OS release workflows

This directory owns AOSP, Debian/Linux image, installer, update-manifest, and
OS release automation. Android/iOS application builds remain in `elizaOS/eliza`;
the Cuttlefish lane checks out that repository only to produce the application
APK that is staged into the system image.

`elizaos-os-full-release.yml` is the only GitHub Release writer. It is manual,
dry-run by default, binds one source SHA and candidate manifest, builds every
distribution surface, and publishes only after strict artifact, checksum,
manifest, and attestation gates pass. Component workflows upload workflow
artifacts only; they cannot race the coordinator by writing release assets.

`build-linux-mkosi.yml` is the canonical Linux v1 producer. It consumes signed
GTK/WebKitGTK artifacts from the pinned Eliza commit, builds and QEMU-boots
snapshot-pinned persistent images on protected native runners, proves exact
virtual-USB readback and two-boot home persistence, generates filesystem SPDX
SBOMs, and signs the complete three-architecture discovery set. It does not
claim installer, logged-in desktop acceptance, or physical hardware evidence;
release assembly remains blocked until those exact-digest lanes pass.
The retired ISO implementation remains as a non-release regression fixture,
but its runnable release workflow has been removed. There is no VM/OVA release
workflow.

Cross-repository source-verification jobs resolve
`release/eliza-source.lock.json` and recursively initialize the
Eliza repository's pinned submodules. Release producers consume signed native
artifacts for that exact commit instead of rebuilding application source here.
Update the reviewed lock in a pull request; release workflows never resolve a
moving `develop` branch at runtime. The OS repository intentionally does not
use a root-level Eliza gitlink: the immutable lock keeps the contract
reviewable while verification checkouts still initialize every submodule
owned by `elizaOS/eliza`.

`publish-apt-repo.yml` binds signed metadata to one configured primary-key
fingerprint, publishes the `apt-repo` branch, and deploys that committed tree
through GitHub Pages. Missing credentials or Pages configuration is a release
failure, not a skipped distribution step.

`publish-os-homepage.yml` regenerates the public download list from the exact
populated release manifest, re-verifies the bundle, builds and exercises the
site, and deploys the tested tree to Cloudflare Pages. The coordinator verifies
the resulting production deployment commit before it promotes the staged
GitHub Release.

`update-os-release-manifest.yml` is the manual recovery boundary for existing
release assets. It binds the base, tag, release, exact asset inventory, and
downloaded bytes before opening an evidenced draft pull request; it never
pushes directly to `develop`.
