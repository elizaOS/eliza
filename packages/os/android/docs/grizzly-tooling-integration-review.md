# Grizzly tooling integration review

PR #97 integrates the older local snapshot with the current develop contracts.
This is host-tooling integration, not device boot or release qualification.

- Preserve the current source locks, resolved manifest, complete image inventory,
  source-bound build receipts, APK signer checks, flash authority and runbook.
- Carry forward shared CLI entry-point detection, usable-ADB selection, explicit
  graphics collection failures, keymaster overlay cleanup, and contamination
  detection. Evidence collection stays observational: no automatic adb root,
  reboot, unlock, firmware upload, or MTE changes.
- Pin normal-fastboot targets before constructing executable plans. Refuse an
  absent target, ambiguous inventory, and early ROM recovery for installation.
- Retain the one-hour coherence check and explicit opt-out. Do not silently
  exclude explicit overrides or weaken the window to a day.
- Attestation inspects packaged vendor and system-init contents even when staging
  remains. It rejects stale logical images, extra unattested images and symlinked
  image files. Hash equality does not imply device compatibility or permission.
- Conservative-f2fs attestation is blocked until the packaged vendor_boot ramdisk
  can be verified. A warning about unverified first-stage encryption is insufficient.
- Tests build real ext4 fixtures using e2fsprogs (mkfs.ext4 and debugfs), exercise
  missing and contradictory packaged entries, CLI symlinks, and mocked installer
  success/refusal paths. Unsupported image formats fail closed.

No image build, physical boot, inference, or recovery success is established by
these host tests. Hardware eligibility remains disabled. The old snapshot's
unretained boot hypotheses are not promoted into verified runbook facts.
