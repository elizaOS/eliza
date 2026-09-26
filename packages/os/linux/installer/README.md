# @elizaos/linux-installer-plan

Planning, authorization, and native disk operations for the GNOME installer
launched from a persistent mkosi USB image. The full installation backend and
runnable service are not complete. Current disk-install plans require EFI; BIOS
and unknown firmware are rejected because no matching disk-install boot path exists.
Inventory detects firmware from kernel sysfs unless the service supplies an explicit
override. Missing or unreadable kernel evidence fails the probe.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/os/linux/installer build:native  # build
bun run --cwd packages/os/linux/installer test   # tests
```

The Linux native module requires a C compiler and OpenSSL development headers.
Its retained disk session can capture and verify a durable GPT backup on a
separate disk. Its retained-descriptor GPT operations erase the partition table
or add reviewed partitions, then flush and verify disk bytes and the kernel map.
The caller must supply trusted inventory, authorization, physical alias exclusion,
and storage policy.
The TypeScript disk session binds receipts to the reviewed plan and storage;
the service opens and closes operations sessions under its physical-target lock.
FAT32/ext4 filesystem images can be prepared on independent staging storage with
`dosfstools`, `e2fsprogs`, `mtools`, and `blkid`. The asynchronous native writer checks the
source hash, writes only a newly created reviewed partition, flushes, and verifies
uncached readback. Cancellation waits for native I/O to settle; a failed write
requires explicit recovery. These receipts cover filesystem bytes only.
An optional hash-bound ext4 source preserves factory files while changing the UUID
and expanding the filesystem. The caller must authenticate the source publisher;
a content hash alone does not do that. Source images stay unchanged.
Factory FAT sources can populate new x86_64/arm64 ESPs using Debian's external
GRUB menu layout. EFI binaries, kernels, and the complete initrd sequence are
hash-checked after copying; the generated menu selects installed filesystem UUIDs.
RISC-V embedded menus and modification of a reused ESP are not implemented.
Signed factory metadata binds the image hashes and boot layout to a version,
architecture, expiry, and release sequence. Verification reuses the USB writer's
pinned/revoked Ed25519 key policy; the caller supplies the durable sequence floor.
`produceFactoryManifest` inspects a completed regular GPT image and emits signed
sidecars with exact ESP/recovery hashes. It rejects damaged GPT copies and missing
boot files; it does not establish firmware boot success. Release assembly must
place this metadata outside the hashed partitions before final image signing.
`stageFactorySources` authenticates metadata before reading service-owned source
handles, checks exact partition hashes and staged readback, and publishes into the
existing private image store. The service must select the source and retain its
qualified independent storage session. Failures retain private partial files;
existing store objects are never overwritten.
`DirectoryInstallationSourceSelector` opens `factory-manifest.json`,
`factory-manifest.json.sig`, `factory-esp.img`, and `factory-recovery.img` from a
service-owned 0700 staging directory. Inputs must be regular 0600 files with one
link. It authenticates metadata, persists the release sequence through the USB
writer's existing store, and retains source handles until preparation settles.
The service supplies trusted storage inventory, channel, and release policy;
native storage qualification and complete payload hashing remain mandatory.
`prepareInstallationFilesystems` authenticates and stages the factory sources,
then prepares new home, recovery, EFI, and root images with coordinated UUIDs.
It accepts four newly allocated partitions and preserves failed staging files;
the service still owns source selection, independent storage, authorization, and
target writes. Reused ESPs require a preservation-aware backend.
`PreparedInstallOperationFactory` composes that preparation with native GPT and
filesystem writes for reviewed plans containing four new partitions. It requires
service-owned source selection and release policy, records native effect receipts,
and waits for writes before closing resources. Shrinking and reused ESPs are
rejected before opening the disk session. Its orchestration tests do not qualify
a complete installation or firmware boot.

Factory-seeded roots can receive an explicit UUID-based `fstab` for `/`, `/home`,
and `/efi`. Allocate the root UUID before preparing the EFI menu, then supply the
prepared home/EFI identities to root preparation. Empty or comment-only factory mount tables are replaced after file metadata and
content checks. Custom mount entries require explicit migration; preparation
refuses to overwrite them.
Root preparation resets `/etc/machine-id` to systemd's first-boot marker and,
when the D-Bus state directory exists, seeds a fresh D-Bus machine ID. Existing
regular files and symlinks are replaced without following their targets. This
covers machine identity only; account migration and other host secrets still
require installed-system integration.

`Ed25519OwnerAuthorizationVerifier` checks domain-separated owner approval
signatures through a service-owned key resolver. It binds the owner, plan,
inventory, nonce, and validity window; executor session, expiry, and replay checks
remain mandatory. Trusted key provisioning, revocation policy, and an interactive
approval issuer are not supplied by this verifier.

Metadata embedding, trusted source discovery, complete installed-system integration,
shrinking, bootloader integration, and a runnable service are still required.

Run `bun run --cwd packages/os/linux/installer test:native:qualify` to check
cross-process Linux peer credentials. `native/qualify-disk-session-vm.py --help`
describes the isolated Node disk-session qualification. Its default timeout is one
hour (`--timeout-seconds` overrides it); timeouts retain partial evidence and never
count as qualification. It creates disposable
virtual disks and requires the pinned Debian image, QEMU/KVM, and image tools.
Supply `--installer-bundle` built from `src/index.ts` with
`bun build --target=node --format=esm`, writing the bundle under root `test-results/`.

The VM runner also executes the prepared operation adapter through the real
executor and durable journal on its disposable 80 GiB target, then checks all
four filesystems and the installed mount UUIDs. This qualification uses fixture
owner authorization and an ephemeral factory signing key; it does not qualify
production owner approval or firmware boot.

`SystemdLogindSessionResolver` queries the system bus through Debian's `busctl`,
validates the peer UID and local active unlocked user session, and rechecks session
membership and pidfd liveness. It requires a service-owned UID-to-owner resolver;
account enrollment is not inferred from a username. Bus errors propagate and never
become an authorization success. This adapter does not supply the runnable service.

The Unix server's `shutdown()` stops admission, cancels requests, and waits for
execution and peer cleanup even after a client disconnects. Cleanup errors reject
the shutdown promise. A runnable service must await this operation when stopping;
closing the listening socket alone does not prove native disk writes have settled.
