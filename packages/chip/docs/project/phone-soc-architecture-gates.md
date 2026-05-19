# Phone SoC Architecture Gates

This document is the claim boundary for phone-class architecture work. Run
`make phone-soc-claim-check` before any milestone text claims that a phone SoC
feature is implemented, performant, or compatible.

## Blocked Claims

| Claim | Required evidence before claim may pass |
| --- | --- |
| Android boots | External BSP build logs, boot command transcript, VINTF, SELinux, CTS/VTS intake, and target or virtual-device smoke logs. |
| WiFi/Bluetooth works | Selected radio hardware or module record, firmware provenance, host bus transcript, Android framework dumpsys, CTS/Verifier evidence, and regulatory boundary. |
| AI throughput | Real benchmark run, calibrated target metadata, unsupported op count, CPU fallback percentage, and platform claim level. |
| GPU/display | Display controller verification, graphics stack or framebuffer path, Android HWC/gralloc policy, and visual output transcript. |
| UMA/coherency | Coherency policy, IOMMU isolation, memory QoS, Android buffer lifecycle, and multi-master stress evidence. |
| Tapeout | PD signoff, padframe, package, SI/PI, PDN/current, thermal, DFT, and manufacturing release artifacts. |

Scaffold checks may pass while these claims remain blocked.
