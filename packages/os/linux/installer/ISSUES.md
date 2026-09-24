# Internal installer issue ledger

These are implementation issues, not claims of completed installation support.
The current package produces deterministic plans with `executable: false` and
contains a fail-closed authorization/journal orchestration boundary plus a
root-side local request core. Native Unix peer-credential and logind resolver
implementations are present but are not packaged or composed into a production
service. No OS credential verifier or privileged operation backend is
connected, so the package never changes a partition table.

## P0 — trusted inventory and execution boundary

- **Implement the privileged inventory service.** Return whole-disk stable ID,
  current-boot ancestry, sector geometry, GPT primary/backup validity, exact
  partition/free extents, filesystem health, mount state, encryption state,
  hibernation/Fast Startup state, and shrink minimums. The typed planner and
  executor already bind serial, optional WWN, firmware/sysfs path, logical
  sector size, and GPT disk GUID. The Linux provider now resolves stable IDs
  itself and populates those fields plus exact partition boundaries from fixed
  read-only `lsblk`, `udevadm`, `sfdisk --verify`, and `sgdisk --verify` calls.
  Redundant GPT main/backup integrity is now report-parsed, required, and
  plan-bound; an exit-zero in-memory recovery is rejected. Root-device ancestry
  is now resolved through `findmnt` plus inverse `lsblk` dependencies and is
  also plan-bound; unresolved or stacked boot targets fail closed. Add
  Windows-native encryption probes plus a separately reviewed btrfs
  minimum-size boundary before connecting it to the root service. Unmounted
  NTFS now uses the native read-only forensic info path to bind health, detected
  hibernation/dirty refusal state, exact device size, and a byte-exact shrink
  minimum. That read-only path cannot prove hibernation/Fast Startup is off, so
  the planner still requires independent explicit evidence. Unmounted ext4 now
  uses fixed-argv, read-only native health
  and minimum-size probes;
  only clean 4 KiB filesystems receive resize evidence, while dirty/unhealthy
  filesystems protect the target. Mount state already propagates through
  stacked descendants and must agree with any resize evidence. Unmounted btrfs
  now has a fixed-argv native read-only health check, but intentionally receives
  no automatic-shrink evidence because native minimum-size discovery requires
  a mounted path.
  Complete base inventory is now captured both before and after filesystem
  probes; the kernel block-device generation, hardware identity, geometry, GPT
  state, partition boundaries, mount state, current-boot ancestry, and
  protection state must remain identical so the provider cannot return a
  mixed-time inspection.
- **Connect plan revalidation and authorization to the root service.** The
  library now reproduces the initial inventory/plan ID, verifies an expiring
  owner credential, re-enumerates before every typed action, and stops on
  identity, journal, or inventory drift. Its file-backed journal durably syncs
  every record and directory update, serializes and head-checks appends, and
  fails closed on unsafe files or interrupted locks. The root-side service core
  now accepts only a bounded typed plan request, binds kernel-authenticated Unix
  peer credentials plus a non-reusable process token to the active unlocked
  owner session, rechecks that session immediately before every privileged
  mutation, durably consumes bounded owner nonces under a hard fail-closed
  quota, and serializes every alias for one physical disk identity. Provision
  its owner-only state topology and journal. The bounded AF_UNIX framing
  adapter, atomic `SO_PEERCRED` plus `SO_PEERPIDFD` seam, repeated kernel-handle
  and logind checks, AbortSignal contract, and hardened systemd templates now
  exist. The native credential/pidfd capture and coherent-snapshot bounded
  logind D-Bus resolver are implemented here; packaging must build, install,
  and qualify them and
  supply dedicated socket-group provisioning/membership,
  production root-service composition and OS credential verifier. The service
  core now consumes the transport AbortSignal, stops before further privileged
  operations, awaits in-flight backends, and leaves the durable physical-target
  lock in place on cancellation for explicit recovery. Filesystem-backed tests
  prove cancellation during backup and action execution cannot release the
  target or admit a second attempt. None of those trusted
  values may come from renderer request data. Do not install the unit templates
  until those fail-closed native adapters are present.
- **Implement recoverable GPT mutation.** The journal now retains the exact
  recovery artifact descriptor and re-verifies it before and after each action,
  including resumed execution. Missing/corrupt artifacts and legacy hash-only
  checkpoints fail closed; healthy filesystem-backed checkpoints resume without
  replacing the original backup. Uninstalled native candidates now capture and
  verify exact GPT artifacts, restore them with interruption checks, and refresh
  and verify the kernel partition map in disposable VM qualification. A separate
  uninstalled filesystem primitive exclusively persists and re-verifies artifacts
  through a retained private directory, including file/directory syncs and
  process-interruption checks. A local qualification also kills/reboots disposable
  QEMU overlays at four storage checkpoints and requires a directory-synced
  artifact to survive exact native verification. This discards the guest kernel;
  physical power loss and host storage caches are not modeled. Required trusted
  callbacks are not a production storage policy. Native kernel-ancestry checks
  bind the filesystem to a retained partition and direct whole-disk parent,
  reject the target as storage, and recheck disk generations. Physical alias
  detection, configured-path/mount lifetime and qualified durable media remain
  policy responsibilities. Production
  backup storage/backend composition and power-loss proof remain unfinished.
  Save and verify both GPT headers and
  partition entries to separate recovery media/state, perform typed operations,
  reread the kernel partition table, and prove rollback after every injected
  failure boundary.

## P0 — install-alongside platform lanes

- **Windows/UEFI.** Detect BitLocker, WinRE, dynamic disks, Storage Spaces,
  dirty NTFS, and hibernation. Preparation must run in Windows when required.
  Test NTFS shrink, ESP coexistence, Windows Boot Manager preservation, Secure
  Boot, Windows update, elizaOS removal, and recovery-key prompts.
- **Intel macOS/EFI.** Support only pre-created unallocated space in v1; never
  shrink APFS from Debian. Preserve Apple APFS containers, Preboot/Recovery, and
  EFI files. Test FileVault, macOS updates, Startup Manager, NVRAM reset, elizaOS
  removal, and Internet Recovery on named Intel Mac models.
- **Linux/UEFI.** Test ext4 and btrfs shrink with unmounted healthy filesystems;
  reject XFS/LUKS automatic shrink. Preserve other distributions' boot entries
  without taking ownership of their root filesystems. Test GRUB, systemd-boot,
  Secure Boot, encrypted hosts, and uninstall recovery.
- **Apple Silicon.** Keep the generic planner blocked. Create a separate
  Asahi/m1n1-style installation design, firmware/version matrix, recovery flow,
  and hardware test lane before advertising support.

## P0 — image installation and boot

- Stream the already verified mkosi expanded image into planned root/recovery
  partitions, verify exact hashes, regenerate machine ID/host keys, create the
  owner and persistent state, and install architecture-appropriate boot assets.
- Reuse an ESP only through namespaced files and explicit NVRAM entries. Test a
  full/undersized/read-only ESP and firmware that discards or reorders entries.
- Boot the installed system, recovery entry, and preserved host OS after normal
  install, cancellation, forced power loss, and an intentionally corrupt image.

## P1 — UX and qualification

- Show a before/after partition map, exact preserved/destroyed objects, required
  host-OS preparation, encryption/recovery implications, and a printed/exported
  recovery plan before confirmation.
- Add keyboard/screen-reader installation, low-battery/power checks, disk-health
  warnings, progress derived from verified bytes, and a no-agent safe recovery
  mode.
- Qualify whole-disk and alongside installs on the published x86_64, arm64, and
  riscv64 hardware matrix. QEMU planning evidence alone is not an installation
  or hardware-support claim.
