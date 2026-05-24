# Phase 8 — Mode-parity validation harness

Boot all 4 combos `{amnesia, persistent} × {normal, privacy}`, drive the
*same* feature checklist through each, capture per-combo evidence, diff
behavior across combos, record any divergence in `docs/mode-parity.md`.
No silent feature loss.

## Build from the active variant

The old root-level Linux prototype harnesses were removed from this
branch. Phase 8 should implement the QEMU/parity harness directly under
`variants/milady-tails/scripts/`, using the existing local helpers as the
only stable base:

- **`scripts/boot-qemu.sh`** — canonical local QEMU launch shape for this
  Tails-derived ISO.
- **QEMU monitor/QMP helpers** — use `screendump`, `sendkey`, and clean
  `quit` through a monitor socket for evidence and cleanup.
- **`scripts/usb-write.sh` semantics** — mirror its removable-disk guard
  rails when synthesizing persistent USB images for tests.

## What's new

### `scripts/mode-parity.sh` — the orchestrator
New file in the variant's `scripts/` dir:
- **Combo loop** over 4 `(storage, privacy)` tuples, each driving 2 QEMU knobs:
  - **privacy axis → boot-menu pick.** Boot with `-display none` + a QMP
    socket; wait ~3 s for the boot menu; `privacy` combos `send-key` one
    `down`+`ret` to select "elizaOS — Privacy Mode", `normal` combos `ret`
    immediately. Screendump the menu as evidence.
  - **storage axis → disk topology.** `amnesia` combos boot `-cdrom`-style,
    no writable partition. `persistent` combos synthesize a `usb.img`,
    append a persistence partition, and run the persistence flow *before*
    the feature checklist.
- **Per-combo isolation** — unique SSH port (2231–2234),
  unique QMP/serial sockets, unique `-name`, per-combo artifact dir.
- **Per-combo run** — boot → wait SSH → wait agent → (persistent: run
  persistence flow) → seed calibration → run the shared checklist →
  screendump every probe → capture journals.
- **Cleanup trap** — QMP `quit` + per-combo `pkill`.

### `scripts/mode-parity-checklist.sh` — the shared checklist
Sourced so all 4 combos run *byte-identical* probes. The checklist should
cover onboarding, status, app lifecycle, network, auth, and model/provider
readiness, **plus** these elizaOS Live probes mapped 1:1 to
`docs/mode-parity.md` rows: `app-launches`, `local-llm-chat`,
`build-app-stub`, `set-wallpaper`, `network-status`, `network-mode`
(asserts the privacy-mode chat action reports Tor on/off correctly per
combo), `gpu-accel`, `persistence-marker` (persistent only, after reboot).

Probes *expected* to differ by combo (Tor speed, OAuth blocked, Chromium
leak) are run but recorded as **observed, not asserted** — the diff step
compares them against the matrix's expected value.

### `just mode-parity` recipe
Add to the variant `Justfile`: `mode-parity: ./scripts/mode-parity.sh`.

### The cross-combo diff
After all 4 finish, `mode-parity.sh` builds a 4-column results table (one
row per probe). A **gap** = a probe `OK` in ≥1 combo but `FAIL` in another,
*unless* `docs/mode-parity.md` already marks that row as an expected
difference. Writes `parity-report.md` with the table + a "Gaps detected"
section, in paste-ready matrix-row format. Exit codes: `0` clean, `2`
undocumented gap, `1` a combo failed to boot, `3` setup error.

### Recording a gap
The harness does **not** auto-edit `docs/mode-parity.md` (it's a human
decision per the doc's Acceptance Rule). `parity-report.md` emits each gap
as a paste-ready matrix-row patch + a one-line caveat; the implementer
copies it into the doc. Preferred outcome is always "restore parity"; the
only pre-authorized v1.0 caveat is the Chromium proxy leak.

## Ordered implementation checklist
1. Create `variants/milady-tails/scripts/`.
2. Write `mode-parity-checklist.sh` — the shared app/network/persistence probes; mark expected-difference probes observed-only.
3. Write `mode-parity.sh` — combo loop, `usb.img` machinery, boot-menu `send-key`, monitor screenshot capture, and clean shutdown.
4. Per-combo ports/sockets/`-name`/artifact dirs + cleanup trap.
5. The cross-combo diff → `parity-report.md` with the gap-detection rule.
6. Add the `mode-parity` Justfile recipe.
7. Run against a Phase-7 ISO; fold `parity-report.md` findings into `docs/mode-parity.md`.
