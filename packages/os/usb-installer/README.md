# elizaOS USB Installer

> **Linux Restore is unavailable.** The shipped helper in `native/` is a
> fail-closed identity-retention foundation only; it is not installed or wired
> to the server or UI. See `docs/linux-restore-helper.md` for the security
> boundary and the evidence required before destructive behavior can be added.

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
- Loads the canonical versioned mkosi `.raw.zst` release contract from
  `ELIZAOS_RELEASE_MANIFEST_URL` (or the official default), including sequence,
  expiry, compressed and expanded sizes and hashes, minimum device size, and a
  detached artifact signature URL.
- Verifies Ed25519 over the exact manifest response bytes before decoding or
  parsing. `ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_BASE64` and its independently
  reviewed `ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_SHA256` are mandatory
  build/release and runtime inputs; there is no committed development key or
  unsigned fallback. Production packaging runs `verify:release-key` first and
  embeds the public key, fingerprint, and canonical optional
  `ELIZAOS_RELEASE_REVOKED_ED25519_PUBLIC_KEY_SPKI_SHA256S` list into the Bun
  bundle. The compiled policy takes precedence over runtime environment values.
  Source/dev execution reads the same policy from the environment.
- Persists the highest accepted signed sequence per channel and architecture at
  the absolute path in `ELIZAOS_RELEASE_SEQUENCE_STATE_PATH`. The packaged app
  provisions a per-user Application Support/state path unless an explicit path
  is supplied; source/server execution still requires the variable. Missing,
  corrupt, or rolled-back state fails closed; equal sequences are accepted and
  newer sequences are atomically committed. A manifest that mixes older and
  newer artifacts for the same channel/architecture is rejected.
- Builds a server-side write plan and returns an opaque `planId`.
- Rebuilds and revalidates the plan server-side immediately before executing a
  write.
- Requires explicit data-loss acknowledgement and target-drive identity
  confirmation in the UI.
- Rejects ISO assets, HTTP URLs, expired manifests, placeholder hashes, missing
  signatures, impossible sizes, redirects, and network/parse errors without
  falling back to scraped GitHub assets or fabricated releases.
- Binds the local backend to `127.0.0.1` and only allows localhost browser
  origins from the known app/dev ports or `ELIZAOS_USB_ALLOWED_ORIGINS`.

## Current Live-Write Guardrails

- `ELIZAOS_USB_ENABLE_RAW_WRITE=1` is required for non-dry-run planning and
  execution.
- `/execute` accepts only a server-generated `planId`; renderer-supplied disk
  paths, image URLs, or full write plans are ignored.
- The backend re-enumerates the selected drive before execution and rejects the
  write if the device path or size changed since planning.
- Stored live-write plans expire after five minutes by default
  (`ELIZAOS_USB_PLAN_TTL_MS`) and must be regenerated before execution.
- Shared write safety blocks dry-run execution, missing acknowledgement,
  non-`safe-removable` drives, undersized drives, and placeholder checksums.
- Canonical `.raw.zst` execution is capability-gated per backend. Linux uses
  the verified streaming zstd pipeline, a privileged whole-device writer,
  device flush, and exact expanded-byte readback. macOS, Windows, and any
  unrecognized backend remain fail-closed until they provide the same boundary;
  compressed bytes can never fall through to their legacy ISO writers.

The manifest signature defaults to `<manifest URL>.sig`; release automation may
pin a distinct HTTPS `.sig` URL with
`ELIZAOS_RELEASE_MANIFEST_SIGNATURE_URL`. Artifact Ed25519 signatures cover this
exact UTF-8 descriptor, including its final newline:

```text
elizaOS-artifact-v1
<artifact URL>
<architecture>
<sequence>
<compressed size>
<expanded size>
<compressed SHA-256>
<expanded SHA-256>
```

## Commands

```bash
bun run --cwd usb-installer dev
bun run --cwd usb-installer build
bun run --cwd usb-installer test
bun run --cwd usb-installer typecheck
bun run --cwd usb-installer lint
bun run --cwd usb-installer test:e2e
```

On macOS, smoke the exact Bun runtime embedded in a packaged Electrobun
artifact (including Ed25519, streaming zstd, mock-target readback,
cancellation, and rollback-state behavior):

```bash
bun run --cwd usb-installer test:packaged-runtime:macos -- \
  usb-installer/build/stable-macos-arm64/elizaOSUSBInstaller.app.tar.zst
```

Keep Playwright on its supported Node runner. The packaged-runtime smoke, unit
tests, and the Vite server exercise Bun; running Playwright itself under Bun can
stall browser-context teardown and is not representative of the application
runtime.

Run the guarded Linux virtual block-device write proof:

```bash
bun run --cwd usb-installer test:linux-virtual-usb
```

That test requires Linux, passwordless `sudo -n`, and the kernel
`scsi_debug` module. It creates a disposable 64 MiB removable block device with
model `ELIZAUSBTEST`, writes a trusted 4 MiB image through the same local
server/Linux backend flow, reads the first 4 MiB back, verifies SHA-256, and
unloads the module. It refuses to run if `scsi_debug` is already loaded.
CI runs this proof only on Linux runners that provide the `scsi_debug` module.

Run the local app:

```bash
bun run --cwd usb-installer start
```

Enable live writes only when deliberately testing removable media:

```bash
ELIZAOS_USB_ENABLE_RAW_WRITE=1 bun run --cwd usb-installer start
```

## Backend Contract

`src/backend/types.ts` is the load-bearing boundary between the renderer and
privileged platform operations:

- `listRemovableDrives()` returns drive candidates with `safe-removable`,
  `blocked-system`, or `unknown` safety classifications.
- `listImages()` returns canonical `.raw.zst` metadata only after strict
  validation. Release discovery has no fake/stale ISO fallback.
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
- Blocks removable disks that are mounted as the current root/live-boot media,
  so an elizaOS/Tails live USB cannot overwrite itself.
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
after a signed raw image is written to a real removable drive, read back, and
boot-tested.

The Linux virtual block-device E2E is stronger than a unit test because it uses
real `lsblk`, `sudo`, `dd`, `sync`, and a kernel block device. It still is not a
substitute for physical USB flash and boot validation.

Remaining production hardening:

- Qualify the process-group-terminating canonical cancellation path against
  physical Linux media; legacy ISO writer processes still need
  platform-specific termination handling.
- Add signed privileged helpers for macOS/Windows and stronger Linux helper
  policy.
- Qualify the Linux `raw-image-pipeline.ts` adapter on virtual and physical
  media, then add equivalent signed privileged adapters for macOS and Windows.
  The shared pipeline pins Ed25519 trust, verifies the signed descriptor and
  exact downloaded digest, bounds streaming zstd expansion, and compares exact
  expanded readback bytes to `sha256Expanded`. Unsupported backends remain
  fail-closed and cannot route `.raw.zst` bytes through legacy ISO writers.
- Add packaged-app launch smoke tests and platform hardware/VM write evidence.
