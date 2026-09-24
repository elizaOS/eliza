# elizaOS Linux mkosi image

This is the canonical Debian trixie workstation image definition for elizaOS.
It builds a persistent GPT disk image for `x86-64`, `arm64`, or `riscv64`.
There is no Cage kiosk, live-build hook reuse, amnesic mode, Tor profile, or
hybrid-ISO wrapping in this tree.

The product and release architecture is recorded in
[`../../docs/mkosi-v1-architecture.md`](../../docs/mkosi-v1-architecture.md).

## Build contract

- mkosi 25.3 or newer. This is the version shipped by Debian trixie.
- Debian trixie packages from `main`, `contrib`, and `non-free-firmware`.
- A dated Debian snapshot plus `SOURCE_DATE_EPOCH` is required in release CI.
  A developer build from a rolling mirror is not reproducible and cannot be
  promoted.
- The desktop and agent are staged as signed release artifacts under
  `/opt/elizaos/bin`; application source is never copied into the OS image.
- `python3-cryptography` verifies an Ed25519 signature over the exact archive
  bytes and a separate Ed25519 signature over the exact manifest bytes.
  Neither a private key nor a substitute development trust root is committed
  here.
- Secure Boot signing keys are release inputs and are never committed here.
  Secure Boot is unsupported on riscv64 because Debian does not provide a
  reviewed signed shim chain for that architecture; release metadata must not
  claim Secure Boot parity for RISC-V.
- Native builds use the Debian host's installed tooling. Do not set
  `ToolsTree=default`: mkosi 25.3's generated tools-tree package closure pulls
  the x86-only `grub-pc-bin` package even for an arm64 tools tree. The target
  image's architecture overlay still installs its own correct boot packages.
- Cross-architecture builds require a registered userspace emulator. A parsed
  config or successful rootfs assembly is not boot evidence.

`mkosi.conf` sets `MinimumVersion=25.3` and emits a JSON package manifest and
checksum. Release evidence must archive the tracked repart definitions beside
the output.

## Persistent disk layout

`mkosi.repart/` is the sole partition-layout definition:

| Order | Partition | Initial size | Purpose |
| --- | --- | ---: | --- |
| 00 | EFI System Partition | 768 MiB | UEFI boot resources |
| 05 | BIOS boot | 1 MiB | legacy x86 boot support |
| 10 | discoverable root | 16 GiB | mutable Debian system and package headroom |
| 20 | Linux recovery | 8 GiB | factory/recovery system tree |
| 30 | discoverable home | 2 GiB minimum | persistent owner data; grows to fill |

The recovery copy is selected by the `elizaOS Recovery` GRUB entry and boots
`rescue.target`, which does not activate the GNOME user agent units. This is a
recovery foundation, not proof of a finished graphical recovery workflow. The
entry's `r` hotkey gives the QEMU qualifier an explicit selection mechanism.
A recovery-only oneshot emits its evidence marker only after confirming the
privileged broker service/socket and every user service manager are inactive.

The initial image is intentionally suitable for a 32 GB or larger USB drive.
An early-boot, recovery-disabled `systemd-repart` service resolves the current
root partition's parent disk, grows the final home partition into contiguous
available space, and leaves filesystem growth to the GPT grow-filesystem flag.
Failure is explicit; it never guesses a disk when the root parent is unclear,
when another GPT home partition exists, or when elizaOS home is not physically
last. Those guards are required for the supported alongside-install layout.
The installer may write the same layout into free space beside another OS, but
partition discovery, shrinking, boot-manager integration, rollback, and
destructive-path testing belong to the installer rather than mkosi.

## Desktop and agent integration

The base image always installs GDM and GNOME on every architecture. When no
local owner exists, GNOME Initial Setup is responsible for account creation;
production autologin is not configured.

The blue/white brand asset is copied from the repository by the chrooted
post-install script. That script fails if the asset or required GNOME packages
are absent, if a kiosk/autologin/unrestricted-sudo file was imported, or if the
default target is not `graphical.target`.

The globally enabled `elizaos-session.target` starts two unprivileged user
units after owner login. Stable `/usr/bin` wrappers dispatch into the signed
artifact payload:

- `/opt/elizaos/bin/eliza-agent`
- `/opt/elizaos/bin/eliza-desktop --tray --overlay`

`/usr/bin/eliza-doctor` dispatches to the optional artifact doctor entrypoint.

Both executables are supplied by the signed desktop artifact. The mkosi tree
only owns the integration contract. The user agent has no sudo rule and is not
UID 0. A separately packaged, root-owned system service is the boundary for
privileged computer-control operations.

The broker implementation and its systemd, sysusers, tmpfiles, protocol, and
polkit assets are installed directly from the sibling `linux/control/` source
tree. The mkosi hook fails if any required source file is absent or replaced by
a symlink. It enables only the local broker socket. The emergency-disable
oneshot is installed for the trusted local UI but is not boot-enabled; doing so
would disable Full Control on every boot. Recovery adds kernel-command-line
conditions that prevent both broker service and socket activation.

Builds default to explicit `development` mode so the base GNOME image can be
assembled before a desktop artifact is available. Release CI must set
`ELIZAOS_BUILD_MODE=release` and supply both
`ELIZAOS_DESKTOP_SIGNING_PUBLIC_KEY` (a PEM or DER Ed25519 public-key path
visible inside the build) and
`ELIZAOS_DESKTOP_SIGNING_PUBLIC_KEY_SPKI_SHA256` (64 lowercase hex characters)
from independently protected release configuration. The latter pins the
canonical DER SubjectPublicKeyInfo bytes; a key file supplied beside an
artifact cannot redefine the trust root. If either external input is absent,
the build fails closed.

Before trusting any metadata, the release path verifies the adjacent fixed-name
`desktop-artifact-manifest.json.sig` over the exact bytes of
`desktop-artifact-manifest.json`. It then validates all three archive-relative
`bin/*` entrypoints, v1 capabilities, shell topology, architecture, archive
SHA-256, key type and pin, and a separate raw or canonical-base64 Ed25519
signature over the exact archive bytes.
It also checks the native GTK shell's authenticated ELF machine ID against the
target architecture. Agent and doctor entrypoints must be either shebang
scripts or little-endian 64-bit ELF binaries for that same architecture. This
prevents cross-architecture replay and rejects unrecognized executable formats
before any payload is installed.
Symlinked manifest, archive, signature, and public-key inputs are rejected. The
portable negative test uses a public RFC 8032 test vector and commits no
private material:

```sh
python3 scripts/test_verify_desktop_artifact.py
```

It requires the Python `cryptography` package; the image obtains that package
from Debian as `python3-cryptography`.

## Commands

The existing repository wrapper remains usable while it is migrated:

```sh
make mkosi-lint
make mkosi-summary ARCH=amd64
make mkosi-build ARCH=amd64 MKOSI_EMIT_ISO=0
make mkosi-build ARCH=arm64 MKOSI_EMIT_ISO=0
make mkosi-build ARCH=riscv64 MKOSI_EMIT_ISO=0
```

### Apple Silicon Mac execution

mkosi itself requires Linux namespaces. On Apple Silicon, the preferred local
route is one native arm64 Debian 13 VM using Lima's `vz` driver and Apple's
Virtualization.framework. This avoids a second container layer and builds
arm64 natively. The checked-in harness never installs Homebrew software or
deletes a VM:

```sh
scripts/mkosi-macos-lima.sh doctor
scripts/mkosi-macos-lima.sh commands

# After reviewing `brew info lima` and choosing to install it:
brew install lima
scripts/mkosi-macos-lima.sh start
scripts/mkosi-macos-lima.sh provision
scripts/mkosi-macos-lima.sh preflight-arm64
scripts/mkosi-macos-lima.sh build-arm64
mkdir -p /path/to/empty/export
scripts/mkosi-macos-lima.sh export /path/to/empty/export
```

The VM uses Lima's Debian 13 template, native `aarch64`, 8 vCPUs, 12 GiB RAM,
a 96 GiB guest disk, no containerd, and a read-only virtiofs mount of this
repository. Build scratch and the expanded disk stay under `/var/tmp` on the
VM disk. Export refuses a missing or nonempty host directory. The preflight and
build explicitly allow the current dirty development tree, so their output is
not release evidence.

The VM provisions qemu-user/binfmt for development x86_64 and riscv64 work,
but the harness deliberately exposes only native arm64 assembly. Promoted
x86_64 and arm64 images still require native Linux runners, while RISC-V still
requires its named QEMU and physical-board matrix. QEMU system boot inside this
VM uses TCG, not nested KVM, and is a functional smoke test rather than a
performance result.

VZ is the default. Where VZ is unavailable but Homebrew QEMU/HVF is already
configured, set `ELIZAOS_LIMA_VM_TYPE=qemu`; the harness switches the source
mount from virtiofs to 9p. Provisioning and build commands also work with an
already-running Lima instance selected through `ELIZAOS_LIMA_INSTANCE`.

Direct Linux qualification entrypoints are also available. They always write
JSON evidence, return nonzero on missing prerequisites or failed markers, and
never turn a preflight into build/boot evidence:

```sh
sudo scripts/mkosi-linux-build.py \
  --architecture amd64 --output-dir out/mkosi \
  --evidence evidence/mkosi-build-amd64.json

scripts/mkosi-qemu-qualify.py \
  --architecture amd64 --image out/mkosi/elizaos-linux-x86-64.raw \
  --firmware-code /path/to/OVMF_CODE.fd \
  --firmware-vars /path/to/OVMF_VARS.fd \
  --transcript evidence/qemu-amd64.log \
  --evidence evidence/qemu-amd64.json

# Select the GRUB recovery entry and require the recovery-only service marker.
scripts/mkosi-qemu-qualify.py \
  --architecture amd64 --boot-mode recovery \
  --image out/mkosi/elizaos-linux-x86-64.raw \
  --firmware-code /path/to/OVMF_CODE.fd \
  --firmware-vars /path/to/OVMF_VARS.fd \
  --transcript evidence/recovery-amd64.log \
  --evidence evidence/recovery-amd64.json

scripts/mkosi-qemu-qualify.py \
  --architecture amd64 --image out/mkosi/elizaos-linux-x86-64.raw \
  --firmware-mode bios --bios /usr/share/qemu/bios-256k.bin \
  --transcript evidence/qemu-legacy-bios-amd64.log \
  --evidence evidence/qemu-legacy-bios-amd64.json

sudo scripts/mkosi-persistence-qualify.py \
  --architecture amd64 \
  --source-image out/mkosi/elizaos-linux-x86-64.raw \
  --work-image out/qualification/elizaos-linux-x86-64-usb.raw \
  --firmware-code /path/to/OVMF_CODE.fd \
  --firmware-vars /path/to/OVMF_VARS.fd \
  --transcript-directory evidence/persistence-amd64 \
  --evidence evidence/persistence-amd64.json

scripts/mkosi-reproducibility-qualify.py \
  --build-a-evidence evidence/build-a.json \
  --build-b-evidence evidence/build-b.json \
  --compressed-a isolated-a/elizaos-linux-x86-64.raw.zst \
  --compressed-b isolated-b/elizaos-linux-x86-64.raw.zst \
  --image-a isolated-a/elizaos-linux-x86-64.raw \
  --image-b isolated-b/elizaos-linux-x86-64.raw \
  --evidence evidence/reproducibility-amd64.json \
  --diffoscope-report evidence/reproducibility-amd64.diffoscope.txt
```

The builder defaults to an explicitly identified development build and rejects
a dirty source tree unless `--allow-dirty-development` is passed. A release
preflight additionally requires `--build-mode release`, a dated
`--debian-snapshot-url`, numeric `SOURCE_DATE_EPOCH`, and the external desktop
signing public-key path and SPKI pin. It also requires
`--desktop-artifact-dir`, containing exactly the schema-v1 manifest, its fixed
manifest signature, named archive and archive signature, and the externally
supplied public key. The key's image
path must be a direct child of `/opt/elizaos/share`; mkosi stages this directory
before the post-install verifier runs. Evidence records the Git commit, dirty
state, mkosi configuration-tree digest, build mode, snapshot, output hashes,
staged input hashes, and the bounded assembly-only claim. It is local evidence,
not a signature or promotion record.

The reproducibility qualifier accepts two distinct clean release-build records
and their exact compressed/expanded image pairs. It rejects drift in the source
commit, mkosi configuration, profile, Debian snapshot, `SOURCE_DATE_EPOCH`,
mkosi version, or signed desktop inputs before comparing outputs. Each expanded
image must reproduce the `.raw.zst` bytes bound by its build record. The tool
then resolves and hashes the architecture-specific Discoverable Partitions root
GPT range, allowing unrelated GPT disk identifiers to differ without weakening
the root-filesystem claim. A
root mismatch fails and invokes diffoscope on bounded root-partition extracts;
the diagnostic report is retained in the JSON evidence. This tool proves only
the two-build root-byte boundary, not that builds were run, booted, or isolated;
release orchestration must supply records from two genuinely isolated builds.
Both evidence output paths must be new and distinct from every input path.

The build evidence claim ends at disk assembly and requires exactly one raw
disk plus a JSON manifest and checksum output. The QEMU lane requires a
decompressed raw disk and one explicit firmware topology: pflash UEFI code plus
a variables template, or `--firmware-mode bios --bios` with one combined
firmware image. These modes cannot be mixed; a RISC-V OpenSBI+EDK2 chain must
be supplied in the form expected by the selected mode. QEMU selects its default
CPU model unless an operator deliberately passes `--cpu`, avoiding an implicit
TCG-only model when KVM is active. Qualification requires the serial markers
`Linux version` and `Reached target Graphical Interface`. Its
default disk topology is removable xHCI USB; `--disk-interface virtio` is a
development-only comparison and does not satisfy the removable-media release
criterion. Additional `--required-marker` values can strengthen but cannot
replace the two built-in markers. Its
temporary QEMU snapshot must leave the hashed source disk byte-identical. Its
claim ends at graphical-target boot: it does not prove owner login or GDM pixels.
Promotion additionally requires the exact x86_64 expanded disk to pass a
second removable-USB boot with an explicit, hashed legacy BIOS image. UEFI
evidence cannot substitute for that record, and legacy BIOS evidence is not
accepted for arm64 or riscv64.
The signed publication-input artifact retains the build record, firmware-bound
QEMU records and transcripts, and both persistence-boot transcripts alongside
the image and SBOM instead of reducing those checks to an untraceable label.

The persistence qualifier never mutates that immutable source. It creates a
larger disposable disk, writes the exact expanded bytes through a loop block
device, hashes the exact readback range, and attaches the same disk to QEMU as
removable USB. It requires the home partition and ext4 filesystem to grow on
the first boot, writes a sentinel to that filesystem, boots again, and mounts
home read-only to verify the sentinel. Its claim still does not prove
tray/overlay behavior, Cloud authentication, agent computer control, local
models, suspend/resume, passthrough devices, or physical hardware. A RISC-V
combined OpenSBI/EDK2 image uses `--firmware-mode bios --bios`; it must not be
combined with pflash inputs.

After all three exact expanded disks have passed their architecture-specific
qualification, stage them beside their `.raw.zst` forms using the canonical
`elizaos-<version>-<architecture>.raw[.zst]` names. The protected signing job
then creates deterministic detached signatures and the byte-exact discovery
manifest consumed by the USB Installer:

The artifact root is a fresh, signer-owned mode-`0700` offline staging tree,
not a publication directory. The protected runner must be isolated from every
other process running as the signing UID; mode bits cannot protect one process
from another process with the same credentials. No process may copy, upload,
or otherwise observe it as a release source while the signer is running. The
signer writes outputs from the already-verified staged file handles, durably
stores every detached signature, and creates the manifest last as the
release-set commit marker.
The independent verifier opens every input without following a final symlink,
verifies and retains those descriptors, and exclusively creates its fresh
publication-input tree from those same held bytes. That new tree's canonical
parent must be signer-owned and not writable by group or world; the verifier
holds and validates the parent and durably syncs the exclusive directory entry.
The workflow never reopens
the private signed paths for copying. The signer never replaces
an existing committed set. If it fails, is killed, or reports unfinished
`.elizaos-release-stage-*` state, discard the entire private artifact root and
restart from the reviewed pre-signing artifacts; do not delete individual
files or retry in place.

```sh
SOURCE_DATE_EPOCH=<reviewed-commit-epoch> \
ELIZAOS_RELEASE_ED25519_PRIVATE_KEY_PKCS8_BASE64=<protected-secret> \
ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_BASE64=<reviewed-public-key> \
ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_SHA256=<independently-pinned-lowercase-sha256> \
node ../../../scripts/sign-image-release.mjs \
  --artifact-root /release/images \
  --version 1.0.0-beta.1 \
  --channel beta \
  --sequence 1 \
  --expires 2027-01-01T00:00:00.000Z \
  --base-url https://download.elizaos.ai/os/releases/v1.0.0-beta.1/ \
  --output /release/images/manifest.json

ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_BASE64=<reviewed-public-key> \
ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_SHA256=<independently-pinned-lowercase-sha256> \
node ../../../scripts/verify-image-release.mjs \
  --require-private-root \
  --artifact-root /release/images \
  --manifest /release/images/manifest.json \
  --publish-root /release/publication-input
```

Omit `--require-private-root` and `--publish-root` when independently verifying
an already published or extracted release tree. Public verification retains the
previous permission-neutral behavior; publication creation is available only
inside the isolated private-root ceremony.

For emergency revocation, set
`ELIZAOS_RELEASE_REVOKED_ED25519_PUBLIC_KEY_SPKI_SHA256S` to a sorted, unique,
comma-separated list of revoked SPKI SHA-256 digests. Verification rejects a
matching key before reading or activating manifest metadata, and signing
rejects it before parsing release metadata or inspecting image inputs. Pass the
same optional revocation variable to both commands during a signing rehearsal.

The private key is read only from the environment. The signer never writes it,
and the verifier independently checks the JSON schema, manifest signature,
each metadata signature payload, exact compressed and expanded sizes/digests,
future expiry, common release identity, and complete three-architecture set.
`SOURCE_DATE_EPOCH` makes the manifest bytes and Ed25519 signatures reproducible
for identical inputs.

`gui`, `secure`, and `secure-gui` are compatibility profile names. GNOME is in
the base image; the secure profiles add ordinary Debian hardening packages and
do not change persistence or privacy behavior.

## Current evidence boundary

Static lint verifies the configuration structure and rejects the retired kiosk,
autologin, Tails/privacy packages, broad sudo, divergent architecture shells,
and non-persistent layouts. It does not prove that an image assembled or
booted. Each architecture still requires a clean build, QEMU boot evidence, and
physical-hardware qualification before release.
