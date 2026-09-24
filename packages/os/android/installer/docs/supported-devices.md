# Supported devices

A marketing name or a legacy `lab-validated` label cannot authorize flashing.
The signed v2 contract must match the exact model, SKU, storage capacity,
firmware, layout, tools, source inputs and artifact digests, and bind current
qualification evidence. The reviewed inventory independently controls
production and lab eligibility.

| Target | Current status |
| --- | --- |
| Cuttlefish x86_64, ARM64, RISC-V, RISC-V E1 | Product definitions exist. Each release requires exact-image boot/runtime evidence. Build-only workflow success is unqualified. |
| Pixel 11 Pro (`grizzly`) | Pinned generated candidate; signed installer adapter implemented but hardware qualification pending. Production and lab eligibility remain false. |
| Pixel 9a (`tegu`) | Source-pinned candidate. No v2 execution adapter or retained hardware qualification yet. Planning-only. |
| Light Phone III (`TLP301`) | No validated device/kernel/vendor/firmware/recovery image contract. Blocked. |
| Other Pixel 11 models | Not covered by the grizzly adapter. Reject rather than cross-flash. |

Add a target only with its own source lock, artifact/layout and firmware
contract, execution adapter, negative tests and exact-device qualification.
Keep shared application logic separate from hardware adapters. Never map a
whole product family to a generic `pixel-arm64` release.

A scoped lab experiment is distinct from a public installable release. It
requires independently signed exact-image authorization, known stock/recovery
and rollback state, Cuttlefish and artifact-validation evidence, and explicit
lab eligibility. It does not qualify a public release or permit relocking.

See [the shared contract guide](../../../../../scripts/android/README.md) and
[implementation status](../../docs/install-safety-implementation.md).
