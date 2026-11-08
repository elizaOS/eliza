# Approved educational baseline

## Requirement and approval

The repository owner requested the proposed educational baseline and authorized
repository updates, QEMU verification, and a website documentation update on
2026-11-08. This file records that scoped requirement and implementation plan.
No trading, custody, payment, or existing V38 application feature is authorized
by this kernel experiment. Do not replace those systems.

## Acceptance criteria

- Boot from Multiboot2 into x86-64 C code and log to COM1.
- Allocate usable physical pages from the firmware map; reserve the kernel,
  boot information, and boot modules; provide a small heap and 4 KiB mapping API.
- Switch cooperative kernel threads and handle thread return.
- Deliver version-38 messages through bounded FIFO daemon mailboxes.
- Build an ISO and verify it in real QEMU with serial and exit-status evidence.
- Provide build/run/debug scripts, architecture contracts, and honest limits.
- Publish documentation and verified downloads without changing the application.
- Supply an automation template; enable hosted CI only with authorized workflow
  credentials, and never represent a template as an active workflow.

## Implementation plan

Keep the kernel under `experimental/valhalla-v38`. Run QEMU at 64 and 128 MiB.
Submit kernel changes through a PR against `develop`. Update the independent
`docs/site` publishing branch through a separate scoped website PR. Preserve
all login, wallet, and deployment checks. Verify the deployed route and downloads.
