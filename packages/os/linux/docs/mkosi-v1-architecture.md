# elizaOS Linux v1 architecture

Status: accepted product contract, 2026-08-17.

This document supersedes the Tails-derived, USB-only, amnesic, privacy-mode,
and Cage-kiosk product assumptions elsewhere in this tree. Historical Tails
sources remain only until the mkosi migration is complete; no elizaOS release
may be built from them after the mkosi release gate is enabled.

## Product contract

elizaOS Linux v1 is a persistent Debian 13 workstation assembled by mkosi for
`x86_64`, `arm64`, and `riscv64`.

- GNOME Wayland is the default desktop. GDM provides a normal owner login.
- The blue and white elizaOS branding is used throughout boot, setup, desktop,
  installer, recovery, and lock-screen surfaces.
- The Eliza tray, overlay, and local agent start in the logged-in user session.
- Model inference may run in Eliza Cloud. Computer and system actions execute
  on the local machine.
- Full Control is enabled during owner setup on elizaOS images. It includes an
  explicitly audited arbitrary-root execution capability.
- USB installations are persistent by default and may run indefinitely.
- The same media provides guided whole-disk and install-alongside flows for
  Windows, macOS, and Linux installations.
- A phone or web session may act as an authenticated remote for the local
  agent. It never connects directly to the root service.
- Recovery and Safe Mode boot without the Eliza agent or privileged service.

Privacy Mode, Tor routing, and amnesia are not v1 release axes. Encryption is
still recommended because the workstation stores login credentials and user
data; this is a device-security property rather than a privacy-mode product.

## Image and boot contract

The canonical artifact is a signed, compressed GPT disk image:

`elizaos-<version>-<architecture>.raw.zst`

Normal USB creation must not consume an ISO. Release metadata conforms to
`release/schema/elizaos-image-manifest.schema.json` and binds the
compressed bytes, expanded bytes, architecture, minimum target size, release
sequence, expiry, and detached signature.

The mkosi tree must define its partitions explicitly with `mkosi.repart/`.
The minimum layout is:

1. EFI System Partition with the architecture's removable boot path;
2. recovery resources and a boot entry that disables all Eliza services;
3. writable Debian system storage;
4. persistent owner and Eliza state that can grow to available space.

The exact filesystem and encryption choices are release inputs and must not be
inferred by a writer or installer. The first boot must generate a unique
machine ID, host keys, owner credentials, and device credentials.

## Installation contract

The boot menu offers:

1. Run elizaOS from this USB;
2. Install elizaOS;
3. Recovery / Safe Mode.

The installer supports both guided whole-disk installation and an alongside
flow. Alongside installation must never shrink or mutate a filesystem until
the planner has proved that the filesystem supports online/offline shrinking,
the requested result satisfies minimum-size rules, recovery material exists,
and the owner confirms an exact before/after plan. BitLocker, FileVault,
LUKS, hibernation, dirty filesystems, unsupported volume managers, and
uncertain partition identity block automatic resizing. A blocked alongside
plan may direct the owner to prepare free space in the existing OS; it must not
offer a force override.

"Alongside macOS" is two separate qualification targets. Intel Macs use the
EFI/APFS path. Apple Silicon requires an explicitly supported Asahi-style boot
chain and machine model; generic arm64 UEFI logic is not sufficient. The
installer must identify the machine and show an unsupported result rather than
apply Intel or PC partition logic to an unqualified Apple Silicon model.

Installation is not a blind disk clone. It applies the signed release layout,
regenerates machine-specific identity, installs the correct boot entry, and
performs filesystem and boot validation before declaring success.

## Desktop and architecture contract

All three architectures use one user-session topology and one visible UI.
Software rendering on early RISC-V hardware is compatible with the native
Linux shell: the shell defines application behavior, while Mesa/LLVMpix or a
GPU driver determines how GNOME and GTK draw it.

The current Electrobun runtime does not provide a supported riscv64 target.
The release must therefore either ship a first-party GTK/WebKitGTK Linux shell
that consumes the shared renderer and agent APIs on all three architectures,
or produce a fully tested upstream-quality riscv64 Electrobun toolchain. An
Epiphany kiosk fallback is not product parity.

RISC-V support means QEMU `virt` plus named physical boards. It never means all
RISC-V firmware and boards. Software rendering is acceptable for the initial
qualified boards when the complete GNOME, tray, overlay, Cloud, browser, and
computer-use acceptance suite passes.

Secure Boot is unsupported on riscv64. Debian does not provide the reviewed
signed shim chain required by this release contract, so RISC-V release and
marketing metadata must not claim Secure Boot parity.

## Full Control contract

The UI, renderer, browser automation, model client, and plugins run as the
logged-in user. A root-owned local service performs system mutations. This is
a process and recovery boundary, not a reduction in product capability.

The root service:

- listens only on authenticated local IPC;
- binds requests to the active owner session and device;
- supports typed operations and an explicit arbitrary-root `exec` method;
- receives executable plus argument vector, working directory, bounded
  environment, timeout, output limit, and request nonce without shell-string
  interpolation by default;
- records redacted authorization and completion receipts;
- rejects replay, stale authorization, unsafe inherited file descriptors, and
  requests while the emergency disable flag is set;
- has no model, plugin loader, web renderer, or network listener.

Full Control is enabled by default after owner setup. Irreversible disk,
boot/authentication lockout, trust-root replacement, user deletion, recovery
disablement, and factory-reset actions require a local catastrophic-action
confirmation. The emergency stop and Recovery / Safe Mode remain independent
of the agent.

## Phone remote contract

The phone talks to an authenticated Cloud relay or a locally paired agent. A
remote command is delivered to the local user-session agent, checked against
the device/session grant, shown in the local activity UI, and only then routed
to desktop tools or the root service. Cloud and phone credentials can never
invoke the root service directly.

Release tests cover pairing, device revocation, replay, offline delivery,
stale commands, concurrent local and remote actions, screen lock, local pause,
catastrophic confirmation, and a compromised/revoked phone.

## Update and recovery contract

V1 uses signed Debian/application repositories plus a pre-update snapshot or
equivalent rollback point. Recovery can disable Eliza, restore the last known
good system state, repair boot entries, and revoke Cloud/phone devices without
starting the agent. Immutable A/B roots may be added later but are not a v1
requirement because elizaOS deliberately permits local system administration.

## Release evidence

Every supported architecture requires the exact promoted digest to pass:

- clean pinned mkosi build and signed-manifest validation;
- UEFI QEMU boot, graphical login, tray, overlay, Cloud sign-in and first reply;
- persistent USB reboot and full writer readback;
- whole-disk and alongside-install success and failure-path tests;
- normal desktop, browser, Wayland computer use, arbitrary-root execution,
  emergency stop, Safe Mode, update rollback, and phone remote tests;
- native hardware qualification for x86_64 and arm64;
- QEMU plus the published named-board matrix for riscv64.

Build success without this boundary evidence is a development artifact, not a
v1 release.
