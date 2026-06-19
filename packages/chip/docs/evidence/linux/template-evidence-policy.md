# Linux Evidence Template Policy

This page describes the convention used by the `*.template.log` files in
`docs/evidence/linux/`. Template files document, in one place, the marker
contract that a real captured transcript must satisfy for the
corresponding fail-closed gate to leave BLOCKED status and move toward
PASS. They are not themselves accepted as evidence.

## What a template file is

A template evidence file:

1. Lives next to the canonical evidence files in
   `docs/evidence/linux/` and has a filename suffix of `.template.log`.
   The canonical evidence paths consumed by gate scripts (for example
   `eliza_e1_serial_boot.log`, `eliza_e1_npu_ml_smoke.log`,
   `eliza_e1_kernel_build.log`, `opensbi_fw_dynamic_handoff.log`,
   `e1-mmio-smoke.log`) do not carry the `.template.log` suffix, so no
   gate script ever reads a template directly.
2. Starts with the literal first line:

   ```text
   STATUS: BLOCKED — template evidence; replace with captured transcript after qemu/Cuttlefish/board run
   ```

   This banner is the file's own self-declaration that it is not real
   evidence. It is the same `STATUS: BLOCKED ...` shape the
   fail-closed gates emit on stdout.
3. Carries the claim boundary
   `template_evidence_only_no_silicon_or_qemu_boot_claim`, matching
   the boundary used by the other BLOCKED evidence files in this
   directory. No silicon, qemu, Cuttlefish, or board claim follows
   from a template file.
4. Documents every marker the corresponding `check_*` script looks
   for, in the order the script enumerates them, with each marker
   prefixed `# REQUIRED_MARKER:` (or `# REQUIRED_AT_LEAST_ONE_OF:` /
   `# REQUIRED_MIN_BYTES:` / `# REQUIRED_SOURCE_MARKER:` for the few
   non-line-marker checks the gates also run). The `# REQUIRED_MARKER:`
   prefix means the literal marker string is never present as a bare
   line in the template, which is what keeps the template from
   accidentally passing a gate if it is ever copied to a canonical
   path.

## Why templates exist

The chip-side fail-closed gates
`minimum-linux-target-check` and `minimum-linux-npu-target-check` are
currently BLOCKED because the canonical evidence transcripts have not
been captured yet. Until a contributor runs the qemu-virt RV64,
Cuttlefish RV64, Chipyard Verilator, or eventual silicon flow and
captures real UART/NPU smoke output, the gates must stay BLOCKED.

The templates capture the marker contract that contributors and CI
lanes will need to satisfy when they do run the flow, so that:

- the marker requirements are visible in one greppable place
  (`grep '^# REQUIRED_MARKER:' docs/evidence/linux/*.template.log`);
- contributors do not have to re-derive the contract by reading the
  gate scripts;
- the BLOCKED status of the gates remains a real signal, not a
  silently-passing placeholder.

## How a template is used

When a contributor (or a future CI lane) captures a real transcript:

1. Run the producer command listed in the template's header (and in
   `docs/evidence/linux/eliza-linux-boot-artifacts.json` for the
   kernel-side artifacts).
2. Write the captured transcript to the canonical `*.log` path the
   gate reads (for example `docs/evidence/linux/eliza_e1_serial_boot.log`,
   `docs/evidence/linux/eliza_e1_npu_ml_smoke.log`). Do not edit the
   `*.template.log` file.
3. Verify that every `# REQUIRED_MARKER:` line in the template has a
   matching bare line in the captured transcript, and that none of
   the `# FORBIDDEN:` / `# FORBIDDEN_REGEX:` patterns are present.
4. Re-run the corresponding `make` target. The gate moves from
   BLOCKED to PASS only when the captured transcript at the canonical
   path satisfies every requirement.
5. Keep the `.template.log` file in place. It remains the documented
   contract for the next capture (for example after a kernel bump,
   a new chip revision, or a regression sweep).

## How the fail-closed gates distinguish a template from a real capture

The gates never read the template files. They distinguish capture
from template by the canonical path the gate inspects:

- `scripts/check_minimum_linux_target.py` walks the canonical
  evidence paths listed in `REQUIRED_EVIDENCE` and accepts an entry
  only when the canonical `.log` exists, is non-empty, and contains
  `eliza-evidence: status=PASS`. A `.BLOCKED` sidecar or a missing
  canonical file keeps the gate BLOCKED.
- `scripts/check_e1_npu_linux_smoke.py` reads
  `docs/evidence/linux/eliza_e1_npu_ml_smoke.log` and checks for each
  required marker as a bare substring. Because the templates prefix
  every marker with `# REQUIRED_MARKER:`, the bare marker text is
  absent from the template, so even if a template were placed at the
  canonical path it would still fail the gate.
- `scripts/check_linux_boot_artifacts.py` reads
  `docs/evidence/linux/eliza-linux-boot-artifacts.json` and validates
  each canonical `.log` against the manifest's `required_strings` and
  `forbidden_strings`. The forbidden list includes the banner words
  used in templates (`BLOCKED`, `placeholder`, `substitute`,
  `not run`, `status=FAIL`, `RESULT=FAIL`), so a template's first
  line itself would cause an immediate FAIL if a template were ever
  promoted to a canonical path.

In other words, templates are fail-closed by construction: the
prefix, the banner, and the file-name suffix all conspire to ensure
the gates ignore them and that any accidental copy is rejected.

## Inventory

| Template path                                                          | Documents the contract for                                                                                          | Gate / make target |
|------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------|--------------------|
| `docs/evidence/linux/minimum_linux_kernel_smoke.template.log`          | Linux-kernel smoke evidence: serial boot, kernel build, DTB check, OpenSBI handoff, MMIO smoke, generated-AP boot.  | `scripts/check_minimum_linux_target.py` / `make minimum-linux-target-check` |
| `docs/evidence/linux/minimum_linux_npu_smoke.template.log`             | NPU userspace ML smoke evidence on the integrated Linux+NPU target.                                                 | `scripts/check_e1_npu_linux_smoke.py` and `scripts/check_minimum_linux_npu_target.py` / `make minimum-linux-npu-target-check` |
