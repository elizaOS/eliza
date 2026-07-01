# USB, Storage, and Update Security Evidence

Status: BLOCKED for AVB, A/B OTA, recovery, signed update, rollback, and USB PD
security claims.

This document records evidence requirements only. It does not assert that the
current e1-chip RTL or Android scaffold implements these surfaces.

## Required Evidence Matrix

| Surface | Required before PASS | Current local status |
|---|---|---|
| AVB chain of trust | `avbtool` invocation, chained partition descriptors, public key location, boot-state propagation, and negative boot test with a modified partition | Missing. |
| A/B OTA | Partition table with `_a` and `_b` slots, update_engine logs, slot switch transcript, successful boot from new slot, and rollback to old slot after injected failure | Missing. |
| Recovery | Recovery image build log, recovery boot transcript, signed package install log, failed install for unsigned/tampered package, and data-wipe policy | Missing. |
| Rollback protection | Monotonic rollback index storage, update-time version checks, failed downgrade transcript, and storage reset behavior | Missing. |
| Signed updates | Release/test key separation, signing command transcript, package verification log, and negative test for wrong key and modified payload | Missing. |
| Storage security | Partition map, fstab mount transcript, encryption policy, key source, wipe behavior, and filesystem integrity evidence | Missing. |
| USB data policy | USB role policy, ADB/fastboot enablement rules, production disablement or authenticated enablement evidence, and host/device negative tests | Missing. |
| USB PD policy | PD controller or PHY contract, allowed power/data roles, alternate-mode policy, over-current/over-voltage handling, and policy-engine logs | Missing. |

## Evidence Files to Add Later

Place future transcripts under `docs/evidence/security/` using stable names so
gates can check them without parsing status prose:

- `avb_chain_of_trust.log`
- `avb_tamper_negative.log`
- `ab_ota_success.log`
- `ab_ota_failure_rollback.log`
- `recovery_signed_install.log`
- `recovery_unsigned_negative.log`
- `rollback_downgrade_negative.log`
- `usb_data_policy.log`
- `usb_pd_policy.log`

## Non-Claims

The current repository must not claim Android Verified Boot, A/B OTA readiness,
rollback protection, signed recovery/update enforcement, production ADB/fastboot
policy, USB data-role security, or USB PD policy enforcement until the required
artifacts above are present and reviewed.
