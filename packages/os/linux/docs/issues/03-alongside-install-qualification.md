# installer: implement and qualify whole-disk and alongside installation

Repository: `elizaOS/os`

Suggested labels: `linux`, `installer`, `release-blocker`, `dual-boot`, `hardware`

## Scope

Implement the privileged executor for the deterministic planner under
`linux/installer`. The executor must re-enumerate the disk, verify
stable identity and the exact plan hash, journal every irreversible step, and
remain recoverable after power loss.

## Test matrix

- Windows 11 UEFI/GPT with BitLocker off and with BitLocker on.
- Windows Fast Startup/hibernation enabled and disabled.
- Debian/Ubuntu ext4 and btrfs installations.
- LUKS, LVM, XFS, dirty, mounted, and unhealthy refusal cases.
- Intel macOS/APFS with free space prepared from macOS.
- Apple Silicon through a separately reviewed Asahi/m1n1 integration; generic
  EFI/APFS handling must remain blocked.
- Whole-disk guided installation on x86_64, arm64, and a qualified riscv64
  target.

Use disposable virtual disks first, followed by dedicated physical machines.
Never run destructive tests on a shared developer workstation.

## Acceptance criteria

- Plan and execution inventories match by serial/WWN/firmware path, sector
  size, GPT identifiers, and partition boundaries.
- Existing partitions retain identifiers and byte-for-byte sample hashes.
- Existing OS and elizaOS both boot after alongside installation.
- Boot manager entries remain recoverable and uninstall instructions work.
- BitLocker, FileVault, LUKS, APFS auto-shrink, hibernated Windows, dirty
  filesystems, unsupported Apple Silicon, and stale plans fail before mutation.
- Power interruption at every journal checkpoint resumes or rolls back without
  silently losing the existing OS.
- Exact before/after partition maps and recovery transcripts are retained.
