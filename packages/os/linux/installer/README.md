# elizaOS internal-disk installer planning boundary

This package is the deterministic, non-mutating planning foundation for the
GNOME installer launched from a persistent mkosi USB image. It supports two
product choices:

- guided whole-disk installation;
- guided installation alongside an existing Windows, Intel macOS, or Linux
  installation.

`createInstallPlan()` never edits a disk and every returned plan has
`executable: false`. `authorizeInstallPlan()` can convert that exact reviewed
plan into an executable capability only after a fresh inventory reproduces the
plan id and an expiring local-owner credential verifies. Plans and inventory
fingerprints bind the disk serial, optional WWN, firmware/sysfs path, logical
sector size, and GPT disk GUID in addition to its stable id, path, size, and
partition boundaries. The execution orchestrator then re-enumerates that exact
disk identity before every typed action,
requires a verified GPT backup, and writes a digest-chained durable journal
before and after each operation. An interrupted or inconsistent journal stops
with `InstallRecoveryRequiredError`; actions are never guessed or replayed.

Each action also requires a fresh inventory readback before its completion
checkpoint is written. Erasing must leave an empty, verified redundant GPT;
that action alone may initialize GPT or replace its disk GUID. Creating a
partition must produce exactly the reviewed byte extent and filesystem,
including an unencrypted FAT32 ESP when requested. Shrinking must change only
the reviewed partition end. Other actions must preserve the existing partition
identities and layout, and image/boot operations require their expected root
partition or ESP to exist. The comparison uses an independent pre-action
snapshot even if a backend mutates its inventory argument. A valid operation
receipt cannot override a failed postcondition: execution journals failure,
requires recovery, and never proceeds to later actions or silently replays it.

Physical disk identity remains bound to the reviewed plan throughout execution.
GPT metadata and partition state are bound to the initial authorization or the
last durable checkpoint, permitting reviewed table changes without accepting
unrelated drift. These inventory checks do not prove payload bytes, filesystem
health after a write, or bootability; those require the real backend and
platform qualification.

The verified backup checkpoint retains the complete recovery artifact descriptor:
target stable ID, independent storage stable ID, location and exact SHA-256.
Its digest and original inventory fingerprint remain bound into the journal.
Resuming never generates a substitute backup from an already modified disk.
The backend must reopen and verify those exact saved bytes and immutable
target/storage bindings before and after every action, before the final completion record, and before
returning a previously completed result. Current partition layout may already differ from
the original, so the verifier must not mistake expected table changes for a
new backup. Verification precedes the final owner and inventory revalidation
before mutation; after mutation it precedes the inventory readback and durable
completion receipt. Final completion also refreshes inventory after backup
verification and requires the last durable partition state to match.

Missing, changed or invalid recovery artifacts stop execution and require
recovery. Legacy checkpoints containing only a hash also require explicit
recovery; the executor cannot invent a location or storage identity for them.
Filesystem-backed restart tests reopen a durable completed-action prefix with
healthy, deleted and corrupted backup bytes. They prove the orchestration and
journal boundary, not native GPT backup correctness or power-loss recovery.

`DurableFileInstallJournal` is the Linux file-backed implementation for that
boundary. It requires a pre-provisioned, canonical, owner-only directory; uses
an exclusive per-plan writer lock; appends bounded JSONL records with `fsync`
on both the file and containing directory; and refuses partial records,
symlinks, hard links, unsafe modes, stale locks, and path-like plan IDs. A lock
left by interruption is never silently removed: recovery must inspect it and
the journal before execution can continue.

`PrivilegedInstallService` is the root-side object core for a local IPC adapter.
`parseLocalInstallExecutionFrame()` accepts only raw bytes, bounds them before
JSON decoding, and accepts only the typed `execute-reviewed-plan` request. The
production adapter
must frame exactly one request per connection and reject trailing frames or
bytes. The daemon itself must run as root and requires kernel-authenticated Unix
peer credentials for a non-root process in the active, unlocked owner session.
The adapter must atomically bind those credentials to a kernel-owned,
non-reusable process-liveness handle such as `SO_PEERPIDFD`, reject transferred
connected file descriptors, and never decode that handle from request JSON. A
numeric PID followed by a `/proc` lookup is not this boundary because PID reuse
can occur between those operations. The
owner/session binding and OS credential are rechecked immediately before the
partition-table backup and every privileged disk mutation. Authorizations are
single-use, and every plan targeting the same physical disk is serialized even
when its plan id or `/dev/disk/by-id` alias differs.

`DurableFileInstallServiceState` supplies the replay and target-lock storage
for that boundary. Its pre-provisioned state topology must be owner-only and
must be reached only through trusted, non-symlink directory ancestors;
single-use owner/nonce claims are atomically created and synced without
persisting credentials. Claims have strict field bounds and a durably
serialized hard capacity; consumed records are never automatically removed,
because deletion could permit replay. Capacity exhaustion fails closed pending
an explicit recovery policy. Target locks require and use normalized serial as
their immutable physical identity. WWN remains bound into reviewed plans and
inventory fingerprints but does not select the lock namespace, so transient
WWN presence cannot split one disk across two locks. Duplicate serials
conservatively share a lock. Locks record the plan-bound kernel device
generation when available and
remain after any failed operation or process interruption for explicit
recovery. The production Unix socket adapter must obtain peer PID/UID/GID and
process liveness from the kernel and active-session membership from logind or
an equivalent OS authority; none may come from request JSON.

`LinuxInstallInventoryProvider` is the read-only Linux whole-disk probe. It
accepts only a whole-disk stable ID, resolves it through `/dev/disk/by-id`,
requires the result to be a block device, and invokes absolute-path `lsblk`,
`udevadm`, `sfdisk --verify`, and `sgdisk --verify` commands with fixed argv, a
sanitized environment, and no shell. Its parser binds serial, WWN,
firmware path, sector size, GPT and partition UUIDs, redundant GPT main/backup
integrity, exact byte boundaries,
reported mountpoints, read-only/removable state, and conservative filesystem
and encryption classifications. Unmounted ext4 filesystems are checked with
read-only `dumpe2fs`, `e2fsck -f -n`, and `resize2fs -P` probes. Clean 4 KiB
filesystems receive bounded minimum-size evidence; dirty and unhealthy ext4
filesystems protect the disk, while missing, malformed, non-4-KiB, or failed
probe output emits no shrink claim. Windows-native encryption/preparation
evidence and a separately reviewed btrfs minimum-size boundary remain required.
Unmounted btrfs filesystems are classified with `btrfs check --readonly`; only
an exit-zero report containing the clean marker and no failure diagnostics is
healthy. This deliberately emits no resize minimum because the native
minimum-device-size command requires a mounted path, which would violate this
probe's unmounted safety boundary.
Unmounted NTFS uses `ntfsresize --info --no-action --no-progress-bar`, whose
info path opens with the upstream read-only forensic flag. Successful output
must bind the exact device size before it supplies health, dirty-off, and
byte-exact minimum-size evidence. The read-only mount path does not perform the
upstream hibernation-file check, so successful output never fabricates a
hibernation-off or Fast-Startup-off claim. It also does not infer that BitLocker
is off from an NTFS signature. The planner requires independent explicit
hibernation-off evidence for any alongside plan and BitLocker-off or suspended
evidence before shrinking. Detected hibernation and dirty-journal diagnostics
remain explicit refusal state; missing tooling, malformed output, or failed
probes supply no resize claim. Opaque BitLocker volumes are classified as
Windows and refused because they cannot supply NTFS evidence.
The GPT verifier parses diagnostics as well as exit status because `sgdisk`
may report exit zero after reconstructing a corrupt backup header in memory.
The provider also resolves `/` with `findmnt` and walks its complete inverse
`lsblk` dependency list, so a target backing dm-crypt, LVM, MD RAID, or another
stacked root is protected even when `/` is not mounted directly on a partition.
An overlay, network root, failed ancestry command, or incomplete chain remains
explicitly unresolved and protects every otherwise ambiguous target.
Mount state is propagated from dm/LVM/MD descendants back to their containing
partition and is independently bound into the inventory fingerprint. Any
filesystem-specific resize evidence must agree with that observed mount state.
The provider captures a second complete hardware, GPT, partition, mount, and
boot-ancestry snapshot after all filesystem probes and requires its fingerprint
to match the first snapshot. Re-resolving only the stable symlink is not enough:
the kernel block-device number and generation sequence are also held constant,
so a same-path device replacement, repartition, mount, or protection-state
change invalidates the entire inspection instead of returning mixed-time
evidence.

`createUnixInstallServer()` provides a bounded, one-request-per-connection
AF_UNIX adapter. Its four-byte big-endian length prefix is checked before JSON
decoding; partial frames, oversized frames, and trailing bytes are rejected.
Peer PID/UID/GID must come from a trusted `LinuxUnixPeerCredentialProvider`;
the production implementation must synchronously and atomically capture Linux
`getsockopt(SO_PEERCRED)` plus a kernel-bound `SO_PEERPIDFD`/pidfd handle on the
socket accepted by this process, before any asynchronous work. Numeric-PID-only
implementations do not satisfy the interface. The logind adapter checks that
same handle before and after resolving the process's session and before and
after one `Properties.GetAll` transaction containing the session id, user,
class, state, active, locked, remote, and seat properties. It never constructs
authorization from a sequence of independently read properties. The systemd
templates own
a root-owned `0660` socket for the separately provisioned `elizaos-installer`
group and harden the service. Production listening requires
exactly one systemd-activated listener with `LISTEN_FDNAMES=installer`;
an absent descriptor name is rejected, and the adapter does not accept a
connected descriptor supplied by a caller. Connections have bounded size and
concurrency. Framing has a separate five-second default deadline. Execution
uses a configurable six-hour default bounded to one second through 24 hours,
so admitted installation work is not constrained by the framing deadline.
Execution is accepted only through an
AbortSignal-aware service declaring `confirmed-stop-or-lock-retained`: after a
timeout it must either confirm that work stopped or retain the fail-closed
physical-target lock until work reaches a known terminal state. Transport
execution timeout never claims an unabortable disk mutation was cancelled. The adapter
retains its bounded handler slot and kernel process handle until the handler
actually settles, even after the client socket is destroyed.

The package now contains a Linux N-API `SO_PEERCRED`/`SO_PEERPIDFD` provider and
a bounded `busctl`-based logind D-Bus resolver. Packaging must still build,
install, and qualify the native module, and supply dedicated group membership,
an OS credential verifier, production root-service composition, and an entry
point. `PrivilegedInstallService` now accepts the transport's AbortSignal and
declares `confirmed-stop-or-lock-retained`. It checks cancellation before
admission and privileged operations, awaits any in-flight backend operation
instead of racing it, and rejects after cancellation so the durable target
serializer retains its lock for explicit recovery. An interrupted action is
journaled as failed; cancellation never claims rollback or safe replay. The
trusted pre-mutation hook remains enforced. Until all production adapters are supplied,
`/usr/libexec/elizaos-installer-service` and these unit templates must not be
installed. The package intentionally does not yet provide the OS
credential verifier, filesystem tools, GPT writer, image extractor, or
bootloader backend. Those implementations and
disposable-block-device qualification are required before the typed operation
adapter may be connected to a real disk. A production mutation backend must
open and authenticate the whole-disk block device inside its privileged method,
retain that verified descriptor through the write, and mutate through that
descriptor; reopening an inventory pathname after validation would leave a
device-replacement TOCTOU window. Tests must use inventory fixtures or
disposable virtual block devices only.

## Alongside support contract

- GPT plus UEFI is required. Intel Macs use their existing EFI System
  Partition and require preparation from macOS when APFS space must be freed.
- Windows, Intel macOS, and Linux are supported when sufficiently large,
  aligned unallocated space already exists. Existing partitions are preserved.
- Automatic shrinking is modeled only for healthy, unmounted, unencrypted NTFS,
  ext4, and btrfs volumes with trusted minimum-size evidence. Windows must have
  Fast Startup/hibernation disabled and BitLocker off or suspended.
- The planner refuses to shrink APFS, FileVault, BitLocker, LUKS, XFS, mounted,
  dirty, unhealthy, or insufficiently measured filesystems. The UI must direct
  the owner to prepare unallocated space from the existing OS, then rescan.
- Apple Silicon is not a generic EFI/APFS target. Supporting it requires a
  separate Asahi/m1n1-style boot-chain integration and hardware recovery tests;
  this planner rejects that claim for v1 until that implementation exists.

## Required executor gates

Before any release can mutate a real internal disk, implement and
hardware-test:

1. the production Unix peer-credential/logind and owner-credential adapters
   around the root-owned service core behind the existing typed operation API;
2. whole-disk inventory probes using serial/WWN/unique id, not a mutable device
   path;
3. OS-native filesystem probes and shrink tools with post-resize checks;
4. redundant partition-table backup and recovery instructions;
5. bootloader/NVRAM handling for Windows Boot Manager, Intel Mac EFI, and Linux;
6. signed mkosi image verification before extraction and expanded-root hash
   verification after installation;
7. power-loss, full-disk, cancellation, BitLocker/FileVault/LUKS, Secure Boot,
   and restore testing on each supported platform.

Run the planner checks with:

```bash
bun run --cwd linux/installer test
bun run --cwd linux/installer typecheck
bun run verify:installer-native
```

`verify:installer-native` is the compile/load ABI gate and performs no kernel
qualification. The dedicated Linux CI qualification uses a real cross-process
accepted AF_UNIX connection and must prove peer PID/UID/GID and pidfd live,
exited, and closed states without treating a denied syscall as a skip. A
restricted local sandbox may therefore pass the compile gate while remaining
explicitly non-qualified for the kernel boundary.


## Native GPT snapshot qualification

`native/gpt-snapshot.c` contains candidate primitives for the missing recovery backend.
Its read-only capture operation records the protective MBR sector, primary header/array and backup
array/header through one retained whole-device descriptor. It binds kernel
device number, disk sequence, capacity, logical sector size and the trusted
original plan/inventory binding. It re-reads all captured regions and rechecks
the held identity before returning exact artifact bytes and their SHA-256.
Capture never opens a device pathname, repairs a header or writes any device.

Validation follows the relevant [UEFI GPT structures](https://uefi.org/specs/UEFI/2.11/05_GUID_Partition_Table_Format.html): both actual header and array CRCs,
matching redundant metadata, protective-only MBR, bounded non-overlapping array
locations and usable ranges, non-overlapping partitions, unique nonzero partition
GUIDs and reserved entry bytes. Supported policy bounds are 512/4096-byte logical
sectors, up to 4096 entries and 16 KiB through 4 MiB per declared array, with
128-times-a-power-of-two entry sizes. Hybrid MBRs, invalid redundancy and layouts
outside those bounds fail closed. Relocated arrays, larger entries and a partial
last array sector are supported; no fixed single-partition Restore layout is
assumed. The versioned envelope retains each region byte-for-byte, including
its sector padding, and verification requires its exact trusted digest/binding.

Both existing disposable Debian VM lanes now also qualify this reader on a
separate named virtio disk. Three multi-partition layouts, checksum corruption,
validly checksummed invalid layouts, identity drift, malformed artifacts and
inappropriate descriptors are exercised. Full target and non-target canary
hashes must stay unchanged across capture. The host compares the saved artifact
regions directly with the final virtual disk, retains `gpt-snapshot.bin`, and
binds the source, binary, artifact and transcript hashes into its report.

The separate restore operation copies and verifies the trusted artifact, binding
and expected identity before writing through an exclusively retained buffered
whole-device descriptor. It restores, flushes and reads back the backup GPT copy
before writing the primary array/header and protective MBR, then flushes and
compares all five original regions. Required trusted authorization/cancellation
checks and live descriptor identity checks run between bounded writes and
operations. Results retain the last completed checkpoint, byte count and whether
a write was attempted; an error after an attempted write is incomplete even
when the reported byte count is zero.

Both VM lanes damage only their dedicated GPT fixture disk, then exercise native
restoration, cancellation and child-process termination at seven checkpoints,
with explicit restoration and exact full-disk verification after each interruption.
They also reject invalid artifacts, authorization and descriptor/identity states,
stop after a real read-only transition following a partial write, and verify that
callback mutation cannot replace the copied inputs. All three layouts are restored;
the larger array also exercises cancellation between 64 KiB write chunks.
Process interruption is not
a guest or hardware power cut. Restore success proves restored on-disk metadata,
not bootability or rollback of filesystem/payload writes.

The separate `elizaos_install_refresh_gpt_map` candidate first verifies that the
exact trusted artifact still matches disk bytes. It issues one `BLKRRPART` through
the retained descriptor, checks every kernel partition number and extent against
the original GPT, rejects missing or extra partitions, and rechecks the on-disk
artifact and identity. It uses the kernel's [partition sysfs attributes](https://github.com/torvalds/linux/blob/v6.12/block/partitions/core.c),
whose extents use 512-byte sectors even on a 4096-byte logical-sector disk.
An open partition causing `EBUSY`, cancellation before or after reread, or any
verification failure remains unverified; there is no retry or fallback. Both VM
lanes establish a shifted map with an extra partition, restore GPT bytes while
that stale map remains, and prove explicit refresh restores the exact original
map without changing disk bytes. Success does not establish udev node settlement
or authorize partition descriptors; callers must retain and validate those
descriptors before using them. Additional kernel-only faults remove, shift,
truncate or add a partition after a successful reread; all must fail verification
while both GPT copies remain unchanged.

`native/gpt-artifact-store.c` adds a separate filesystem persistence candidate.
It requires a retained root-owned 0700 directory on an ext-family filesystem,
uses a digest-derived filename, creates a 0600 regular file exclusively, writes
bounded chunks, fsyncs the file and directory, and reopens/verifies the exact
artifact. Verification also syncs the retained file and directory again. Existing
files are never overwritten or silently removed, including after interruption.
File identity, link count, ownership and permissions are checked through retained
descriptors; special files, changed names and corrupt/truncated bytes fail closed.
Required trusted callbacks repeat authorization, cancellation and storage-policy
checks. These callbacks must come from the root backend, never renderer input.

`elizaos_install_check_recovery_storage` supplies a read-only native check for
kernel backing ancestry. It binds the directory's filesystem device to a retained
partition, verifies that partition's direct sysfs parent against a retained whole
disk, checks partition geometry and disk generation, and requires a different
kernel whole-disk identity for the installation target. Both whole disks must have
a direct device and no slave devices; stacked or unresolved storage is refused.
The storage VM fixture invokes this check at each persistence guard and exercises
same-target, wrong-partition/parent, stale-generation and directory-identity
refusals, plus refusal of a real mounted ext4 loop partition. This checks kernel topology, not physical independence: production policy
must still reject hardware aliases (such as two paths to one LUN), qualify the
recovery medium, bind the configured pathname and retain locks/mount lifetime.

The VM qualification stores artifacts on its separate ext4 root disk, exercises
cancellation and child-process exit at four persistence checkpoints, explicitly
reopens complete artifacts, rejects incomplete ones, and preserves interrupted
files against replacement. It also exercises chunk cancellation, unsafe files and
directories, tmpfs refusal, input mutation and replacement of an opened inode.
These are filesystem/process-restart checks, not power-cut tests.

`native/qualify-gpt-vm-interruption.py` separately starts four disposable overlays
from a completed local VM qualification. It kills the exact QEMU process with
SIGKILL after creation, writing, file sync, or directory sync, then boots each
same overlay with a fresh kernel and re-verifies the artifact through the native
reader. A directory-synced artifact must survive byte-for-byte. Earlier checkpoints
may retain a valid artifact or fail closed with no usable output. The prepared
image is read-only backing storage and its digest must remain unchanged.

```sh
python3 linux/installer/native/qualify-gpt-vm-interruption.py \
  --prepared /var/tmp/restore-fd-512 \
  --output-dir /var/tmp/gpt-vm-interruption-512 \
  --container-tools-image elizaos-usb-qualification-tools:local
```

This local KVM test requires the stopped prepared `guest.qcow2`, its original
backing image, logs, report and artifact; downloaded CI reports alone are not
enough. The container supplies only unprivileged image/ISO tools. No host block
devices are attached. Run it for each prepared sector-size lane. Retain the
per-boot logs, seeds, QEMU commands, native source/binary bindings and final
`qualification.json`. SIGKILL discards the guest kernel and QEMU process but
leaves host storage caches and the physical drive powered, so this cannot prove
physical power-loss safety.

The libraries are not installed or connected to the privileged installer.
Filesystem identity and successful syncs alone do not prove independent durable
recovery media: production must resolve and repeatedly verify the physical backing
storage and configured location, retain the target/storage locks, and bind the
artifact into the journal. Production recovery authorization and composition, power-loss
recovery and physical-media qualification remain unfinished. OpenSSL libcrypto is used for artifact hashing
in this candidate; the VM builds it with `libssl-dev` and links `-lcrypto`.
