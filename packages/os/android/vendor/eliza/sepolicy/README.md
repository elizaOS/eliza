# ElizaOS sepolicy

This directory contains the vendor SELinux policy included by
`BOARD_VENDOR_SEPOLICY_DIRS += vendor/eliza/sepolicy` in `eliza_common.mk`.
Policy files live directly under `sepolicy/` because Soong globs this vendor
directory flat.

## Current Policy

`eliza_agent.te` does not define a custom `eliza_agent` domain today. The
on-device app is platform-signed and runs as `platform_app`; the only active
rule allows `platform_app` to execute files labeled `app_data_file` so the app
can start its bundled bun runtime from `/data/data/<pkg>/files/agent/`.

The rule is intentionally documented as a broad userdebug-build allowance in
the `.te` file. A previous custom-domain attempt hit AOSP neverallow checks
around app data labels and vendor domain transitions, so the production path is
to re-scope execution with a custom file label restored by the Java service.

## Files

- `eliza_agent.te` - current allow rule and rationale.
- `file_contexts` - path labels used by the vendor policy.

## Changing Policy

1. Reproduce the denial on a userdebug build.
2. Capture the exact `avc: denied` line from `adb logcat -d` or `dmesg`.
3. Add the narrowest rule that matches the observed access.
4. Rebuild and verify with `scripts/elizaos/validate.mjs`.

Do not document a custom domain here unless the corresponding `.te`,
`file_contexts`, and transition rules actually exist.
