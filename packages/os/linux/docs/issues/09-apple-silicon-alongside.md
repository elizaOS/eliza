# installer(apple-silicon): install elizaOS alongside macOS through an Asahi-style boot chain

Repositories: `elizaOS/os` and `elizaOS/eliza`

Suggested labels: `linux`, `arm64`, `apple-silicon`, `installer`, `release-blocker`

## Problem

Apple Silicon is not a generic arm64 UEFI/APFS computer. The current planner
correctly refuses it. V1 nevertheless requires an alongside-macOS experience,
so it needs a separately reviewed platform implementation inspired by the
Asahi/m1n1 boot and recovery architecture.

## Work

- Select explicitly supported Mac model identifiers and firmware versions.
- Integrate with the supported macOS-side preparation/bootstrap flow rather
  than attempting to shrink live APFS from Linux.
- Preserve macOS Recovery and the ability to select macOS at boot.
- Install the canonical arm64 elizaOS root, persistent state, recovery, signed
  desktop artifact, and update trust root without treating Apple storage as a
  PC GPT target.
- Provide uninstall/reclaim instructions that run from macOS and preserve
  Recovery.
- Test FileVault on/off, reduced-security policy requirements, firmware update,
  failed installation, interrupted download, and lost elizaOS credentials.

## Acceptance criteria

- The installer refuses every unqualified model and firmware combination.
- A supported Mac retains macOS, macOS Recovery, firmware updates, and elizaOS
  across five cold-boot cycles.
- FileVault and secure-boot policy requirements are accurately explained
  before disk changes.
- Eliza Cloud, tray, overlay, Wayland computer use, phone remote, Full Control,
  persistence, update rollback, and elizaOS recovery pass on physical Apple
  Silicon hardware.
- Uninstall restores space to macOS without deleting macOS or Recovery.
- Evidence includes the exact model, firmware, macOS version, OS/image digest,
  partition maps, and recovery transcript.
