# elizaOS USB Installer

Electrobun-targeted microapp for preparing bootable elizaOS USB installers.

This package has two modes:

- Default mode is safe review/demo mode. Raw USB writes are disabled unless the
  backend process is started with `ELIZAOS_USB_ENABLE_RAW_WRITE=1`.
- Live-write mode uses platform backends for Linux, macOS, and Windows. Treat
  this as destructive and hardware-dependent. It must be tested on the target
  platform and real removable media before release.

The renderer never opens raw disks. It talks to the local backend contract; disk
enumeration, privileged writes, and platform subprocesses stay server-side.

## Scope

- Lists removable drive candidates through `UsbInstallerBackend`.
- Presents selectable elizaOS image metadata with channel, architecture, build
  id, published date, URL, SHA-256 checksum, expected size, minimum USB size,
  and optional release/signature links.
- Builds a server-side write plan and returns an opaque `planId`.
- Rebuilds and revalidates the plan server-side immediately before executing a
  write.
- Requires explicit data-loss acknowledgement and target-drive identity
  confirmation in the UI.
- Blocks live writes unless the selected image has a non-placeholder SHA-256
  checksum.
- Binds the local backend to `127.0.0.1` and only allows localhost browser
  origins.

## Current Live-Write Guardrails

- `ELIZAOS_USB_ENABLE_RAW_WRITE=1` is required for non-dry-run planning and
  execution.
- `/execute` accepts only a server-generated `planId`; renderer-supplied disk
  paths, image URLs, or full write plans are ignored.
- The backend re-enumerates the selected drive before execution and rejects the
  write if the device path or size changed since planning.
- Shared write safety blocks dry-run execution, missing acknowledgement,
  non-`safe-removable` drives, undersized drives, and placeholder checksums.

## Commands

```bash
bun run --cwd packages/os/usb-installer dev
bun run --cwd packages/os/usb-installer build
bun run --cwd packages/os/usb-installer test
bun run --cwd packages/os/usb-installer typecheck
bun run --cwd packages/os/usb-installer lint
bun run --cwd packages/os/usb-installer test:e2e
```

Run the guarded Linux virtual block-device write proof:

```bash
bun run --cwd packages/os/usb-installer test:linux-virtual-usb
```

That test requires Linux, passwordless `sudo -n`, and the kernel
`scsi_debug` module. It creates a disposable 64 MiB removable block device with
model `ELIZAUSBTEST`, writes a trusted 4 MiB image through the same local
server/Linux backend flow, reads the first 4 MiB back, verifies SHA-256, and
unloads the module. It refuses to run if `scsi_debug` is already loaded.

Run the local app:

```bash
bun run --cwd packages/os/usb-installer start
```

Enable live writes only when deliberately testing removable media:

```bash
ELIZAOS_USB_ENABLE_RAW_WRITE=1 bun run --cwd packages/os/usb-installer start
```

## Backend Contract

`src/backend/types.ts` is the load-bearing boundary between the renderer and
privileged platform operations:

- `listRemovableDrives()` returns drive candidates with `safe-removable`,
  `blocked-system`, or `unknown` safety classifications.
- `listImages()` returns trusted elizaOS image metadata after manifest
  validation. Invalid URLs, checksums, unsupported channels/architectures,
  missing build metadata, and impossible minimum USB sizes are rejected.
- `createWritePlan()` returns the resolve, checksum, write, verify, and complete
  steps. HTTP-backed plans include a server-generated `planId`.
- `executeWritePlan()` is destructive. The HTTP backend sends only `planId`;
  direct platform backends require callers to pass a plan that satisfies the
  shared `write-safety.ts` guards.

## Platform Notes

macOS:

- Enumerates disks with `diskutil list -plist` and `diskutil info -plist`.
- Derives whole raw disks as `/dev/rdiskN` and rejects partition paths.
- Uses `osascript ... with administrator privileges` for the current prototype
  write path. A signed helper is still the preferred production boundary.

Linux:

- Enumerates block devices with `lsblk --json --bytes`.
- Unmounts mounted child partitions before writing.
- Writes through `pkexec`, cached/allowed `sudo`, `kdesu`, or `doas` plus `dd`.

Windows:

- Enumerates disks through PowerShell `Get-Disk`/`Get-Partition`.
- Blocks boot/system/internal-looking disks.
- Uses UAC-elevated `diskpart` and `dd.exe` or a native PowerShell streaming
  fallback. A signed elevated helper is still required before calling Windows
  production-grade.

## Release Gaps

This package is code-ready only after tests/build pass. It is USB-proven only
after a final ISO is written to a real removable drive and boot-tested.

The Linux virtual block-device E2E is stronger than a unit test because it uses
real `lsblk`, `sudo`, `dd`, `sync`, and a kernel block device. It still is not a
substitute for physical USB flash and boot validation.

Remaining production hardening:

- Replace GitHub release scraping/placeholder checksums with a signed official
  elizaOS image manifest.
- Add cancel/abort support for downloads and active writes.
- Add signed privileged helpers for macOS/Windows and stronger Linux helper
  policy.
- Add readback verification beyond `sync`/eject/status completion.
- Add packaged-app launch smoke tests and platform hardware/VM write evidence.
