# elizaOS USB Installer

Electrobun-targeted microapp scaffold for preparing bootable elizaOS USB
installers.

The current package is intentionally dry-run only. It models the destructive
workflow and safety gates without writing to disks.

## Scope

- Lists removable drive candidates through `UsbInstallerBackend`.
- Presents selectable elizaOS image metadata with channel, architecture, build
  id, published date, URL, SHA-256 checksum, expected size, minimum USB size,
  and optional release/signature links.
- Validates the image manifest before exposing releases to the renderer.
- Builds a write/verify plan that is safe by default and marks privileged disk
  writing as unimplemented.
- Rejects every non-dry-run write request. This package must not implement raw
  device writes.
- Keeps platform-specific disk enumeration and privilege notes close to the
  installer package.

## Walkthrough

1. Pick a trusted elizaOS release and review its manifest fields.
2. Select removable media that meets or exceeds the release minimum USB size.
3. Acknowledge that a real installer would erase the selected drive.
4. Prepare the dry-run plan and inspect each resolve, checksum, write, verify,
   and complete step.
5. Treat any blocked step as a release gate failure. The current backend never
   writes bytes, even when all gates pass.

## Commands

```bash
bun run --cwd packages/os-usb-installer dev
bun run --cwd packages/os-usb-installer build
bun run --cwd packages/os-usb-installer test
bun run --cwd packages/os-usb-installer typecheck
```

## Backend contract

`src/backend/types.ts` is the load-bearing boundary between the renderer and the
future privileged helper:

- `listRemovableDrives()` returns drive candidates with `safe-removable`,
  `blocked-system`, or `unknown` safety classifications.
- `listImages()` returns trusted elizaOS image metadata after manifest
  validation. Invalid URLs, checksums, unsupported channels/architectures,
  missing build metadata, and impossible minimum USB sizes are rejected.
- `createWritePlan()` returns the resolve, checksum, write, verify, and complete
  steps. The dry-run backend never writes bytes and always reports
  `privilegedWriteImplemented: false`.

## Platform notes

macOS:

- Enumerate disks with `diskutil list -plist` and `diskutil info -plist`.
- Unmount the selected disk before raw writes.
- Route writes through a signed helper; renderer code must never open raw
  devices.

Linux:

- Enumerate block devices with `lsblk --json --bytes --paths`.
- Reject mounted devices unless the user explicitly unmounts them.
- Use `pkexec`, `udisks2`, or a small audited helper for privileged writes.

Windows:

- Enumerate removable disks through PowerShell `Get-Disk`/`Get-Volume` or
  SetupAPI.
- Require physical-drive identity confirmation before write access.
- Run raw writes in a signed elevated helper process.

## Electrobun integration notes

This package is structured so Electrobun can host the Vite renderer and bind an
implementation of `UsbInstallerBackend` from the main process. The first real
backend should keep the same interface and replace only the dry-run backend,
with a narrow privileged helper responsible for raw device writes and verify
reads.
