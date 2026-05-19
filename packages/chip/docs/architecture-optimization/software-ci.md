# Software Stack, Performance, CI, and Reproducibility Work Order

## firmware boot

Firmware boot claims require OpenSBI/U-Boot or equivalent source, build logs,
device-tree handoff, boot transcript, and failure-mode evidence.

## Android BSP

Android BSP claims require external AOSP tree logs, vendorimage output,
checkvintf, SELinux neverallow/build logs, CTS/VTS intake, and virtual-device
or target smoke transcripts.

## benchmark

Benchmark claims require real tool execution, calibrated metadata, model
artifacts, power/thermal context, parsed metrics, unsupported op count, and CPU
fallback percentage. Dry-run reports stay blocked.

## CI gates

CI gates must preserve fail-closed behavior: missing tools, missing external
trees, and missing hardware evidence produce blocked status instead of inferred
pass status.
