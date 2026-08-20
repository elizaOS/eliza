# V2 issue proposal: iCloud continuity for Devices & Runtimes

Status: deferred follow-up; do not ship as part of v1.

## Goal

Let a signed-in Apple user recover non-secret Devices & Runtimes metadata and,
only with explicit approval, recover selected controller grants on a replacement
device without weakening device-bound key guarantees.

## Safe v2 scope

- Sync labels, Cloud host/session identifiers, ordering, last-selected runtime,
  and public-key fingerprints through an App Group plus CloudKit or ubiquitous
  key-value storage.
- Treat Cloud as authoritative for revocation and current device membership.
- If grant recovery is added, wrap a newly issued grant to a recovery key under
  explicit user confirmation and require Cloud reauthentication on the new
  device. Rotate the controller identity after recovery.
- Add conflict resolution, device-loss UX, recovery auditing, and tests for
  rollback, stale CloudKit records, and revoked devices.

## Hard exclusions

Never synchronize controller signing/ECDH private keys, SSH private keys,
Headscale auth keys, runtime bearer tokens, Secure Enclave references, or raw
Keychain blobs. Keep `kSecAttrSynchronizable=false` and `ThisDeviceOnly`
accessibility for all v1 secret classes.

## Release gates

- Apple entitlement and App Store privacy review.
- Threat-model review for account takeover and stolen-device recovery.
- Physical-device tests for reinstall, replacement-device restore, revocation,
  and multi-Mac conflicts.
