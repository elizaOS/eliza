# Phone Platform Optimization Work Order

## Display and graphics

Optimize scanout, framebuffer format, bandwidth, underflow detection, and the
Android HAL boundary before any GPU/display product claim.

## Camera

Camera work is blocked on sensor selection, CSI, ISP ownership, tuning package,
calibration records, privacy indicator policy, and HAL or V4L2 transcripts.

## PMIC and platform IO

PMIC, USB, storage, radios, and sensors must be treated as coupled product
systems. Each needs selected hardware, firmware ownership, power/reset/wake
lines, Android service declaration, SELinux policy, CTS/VTS or equivalent
evidence, and negative failure-mode tests.

## HAL

HAL work must remain fail-closed until boot logs, VINTF, service dumps, and
runtime transcripts show the backing device nodes and services exist.
