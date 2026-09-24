# usb: qualify signed raw.zst writing and persistent boot on real media

Repository: `elizaOS/os`

Suggested labels: `usb-installer`, `release-blocker`, `hardware`, `security`

Depends on: canonical image build and production release signing.

## Work

Test the signed USB installer on macOS, Windows, Debian, Ubuntu, and Fedora
hosts using at least two USB controller vendors and two capacity classes.

For every run retain:

- installer version and signature;
- signed manifest bytes and verified key identity;
- compressed and expanded SHA-256;
- stable device identity before and immediately before execution;
- bytes written and full readback digest;
- partition/GPT inspection after write;
- cold-boot evidence and persistent-state reboot evidence.

Fault-inject download cancellation, device removal, same-size device swap,
power loss during write/finalization, insufficient host storage, full target,
expired/rolled-back metadata, invalid signature, corrupt compressed stream, and
readback mismatch. Exercise Restore USB after failure and success.

## Acceptance criteria

- The production UI never offers an ISO or unsigned/fake artifact.
- Internal, system, unknown-identity, stale, and swapped disks are blocked.
- Expanded bytes—not compressed `.zst` bytes—are present on the device.
- Full readback over the expanded image length matches the signed digest.
- The resulting USB cold-boots and preserves owner, Cloud, tray, overlay, and
  agent state across at least three reboots.
- Interrupted media is recoverable with the documented Restore operation.
- Evidence is tied to the exact image and installer digests.
