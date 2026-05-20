<!-- elizaOS Debian RV64 variant — one-page status report for fresh contributors / auditors. -->
# elizaOS Debian RISC-V 64 — STATUS

**Date:** 2026-05-19
**Wave:** 4 (live-build config) + 2B (userland-bootstrap) + e2e-gate scaffold complete
**Status line:** `scaffold_complete_no_iso_built_no_qemu_boot_captured_no_hardware_run`
**Claim boundary:** `status_report_view_only_no_silicon_or_boot_claim`
**Last verified at HEAD:** `86a2c19e6df570b94bec7b2d0aaa717e04d99dbf`

This is a one-page status report. The longer narrative lives in
[`README.md`](README.md), the runbook in
[`docs/e2e-qemu-virt.md`](docs/e2e-qemu-virt.md), and the systemd
contract in [`docs/userland-startup.md`](docs/userland-startup.md).

No claim is made anywhere in this document that an ISO was built from
this checkout, that a qemu-virt boot transcript was captured, or that
any hardware RISC-V board has been brought up. The fail-closed gate at
[`scripts/check_release_manifest.py`](scripts/check_release_manifest.py)
exists to prevent any such claim being promoted without evidence.

## The four sibling pieces

The variant is made up of four cleanly-separated pieces. Each one owns
a single landing commit and a single artifact set. Look at the commit
to see exactly what landed.

| Piece                                 | Commit         | Owns                                                                                                                                                                                                                                                                                                                                                                                  |
|---------------------------------------|----------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 1. Build (Wave 4 live-build)          | `c4656f1810`   | `Dockerfile`, `build.sh`, `auto/config`, `config/package-lists/elizaos.list.chroot`, `config/hooks/normal/0010-elizaos-agent.hook.chroot`, `config/hooks/normal/0020-grub-efi-riscv64.hook.binary`, `config/includes.binary/extlinux/extlinux.conf`, `manifest.json.template`. End-to-end `lb config` → `lb build` → verify → checksum → manifest pipeline against Debian Trixie riscv64. |
| 2. Boot (qemu-virt harness)           | `ebf816ea14`   | `Makefile` (boot targets), `scripts/qemu_virt_boot.sh`, `scripts/qemu_virt_smoke.py`, `scripts/test_qemu_virt_smoke.py`. Wraps `qemu-system-riscv64 -M virt`, emits an evidence JSON conforming to schema `eliza.os.linux.qemu_virt_boot.v1`, greps the serial transcript for the literal marker `elizaos-ready`.                                                                       |
| 3. Userland (Wave 2B systemd bootstrap)| `31bd8f13ba`   | `config/hooks/normal/0030-elizaos-userland.hook.chroot`, `config/includes.chroot/etc/systemd/system/elizaos-{agent,first-boot}.service`, `config/includes.chroot/usr/lib/elizaos/first-boot.sh`, `config/package-lists/elizaos-runtime.list.chroot`, `docs/userland-startup.md`. Creates the `elizaos` system user, the state + config dirs, and writes the `elizaos-ready` line on `/dev/ttyS0`. |
| 4. Gate (e2e runbook + release-check) | `cc10b9f001`   | `Makefile` (release-check targets), `docs/e2e-qemu-virt.md`, `scripts/check_release_manifest.py`, `scripts/test_check_release_manifest.py`. Fail-closed validator against `packages/os/release/schema/elizaos-os-release-manifest.schema.json`. BLOCKED informational by default; FAIL under `--strict`.                                                                              |

## Happy-path command sequence

Lifted from [`docs/e2e-qemu-virt.md`](docs/e2e-qemu-virt.md). Run from
the repo root. Step 1 is fast (warm cache); steps 2 + 3 each take
tens of minutes and pull from the Debian mirror network.

```sh
# 1. Builder image (5 – 15 min cold, 1 – 2 min warm).
docker build -t elizaos-debian-riscv64-builder \
    packages/os/linux/variants/elizaos-debian-riscv64/
# equivalent shortcut:
make -C packages/os/linux/variants/elizaos-debian-riscv64 build-image

# 2. Live ISO (45 – 90 min — multi-GB Debian Trixie riscv64 pull).
mkdir -p packages/os/linux/variants/elizaos-debian-riscv64/out
docker run --rm --privileged \
    -v "$PWD/packages/os/linux/variants/elizaos-debian-riscv64/out:/work/out" \
    elizaos-debian-riscv64-builder
# equivalent shortcut:
make -C packages/os/linux/variants/elizaos-debian-riscv64 build

# 3. QEMU virt boot (2 – 6 min warm). Writes evidence JSON + transcript log.
make -C packages/os/linux/variants/elizaos-debian-riscv64 qemu-boot
# explicit form:
packages/os/linux/variants/elizaos-debian-riscv64/scripts/qemu_virt_boot.sh \
    --iso       packages/os/linux/variants/elizaos-debian-riscv64/out/elizaos-debian-riscv64-<ts>.iso \
    --evidence  packages/os/linux/variants/elizaos-debian-riscv64/evidence/qemu_virt_boot.json \
    --transcript packages/os/linux/variants/elizaos-debian-riscv64/evidence/qemu_virt_boot.transcript.log

# 4. Fail-closed release-manifest gate (< 5 s).
make -C packages/os/linux/variants/elizaos-debian-riscv64 release-check
# strict variant for the release pipeline:
make -C packages/os/linux/variants/elizaos-debian-riscv64 release-check-strict
```

## What runs today on a fresh checkout

The two unit-test targets and the informational gate run without any
external mirror, ISO, qemu state, or hardware:

```text
make -C packages/os/linux/variants/elizaos-debian-riscv64 qemu-virt-boot-test     PASS  (qemu_virt_smoke unit tests)
make -C packages/os/linux/variants/elizaos-debian-riscv64 release-check           BLOCKED (manifest.json.template is `provenance: scaffolding`)
make -C packages/os/linux/variants/elizaos-debian-riscv64 release-check-test      PASS  (check_release_manifest unit + Hypothesis tests)
```

## What stays BLOCKED

| Row                          | Why it is BLOCKED                                                                                                                                                                                                                                                                                                                                                                                            | Owner / cross-link                                                                                                                                                          |
|------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `lb build` run               | Multi-hour build, multi-GB pull from `deb.debian.org` Trixie riscv64 mirror. Cannot run from inside an interactive sub-agent; not committed as a binary artifact. Recipe in [`docs/e2e-qemu-virt.md`](docs/e2e-qemu-virt.md) step 2.                                                                                                                                                                          | builder host or CI; external dependency = Debian Trixie riscv64 mirror availability                                                                                         |
| `qemu-virt-boot` transcript  | Requires the artifact above + `qemu-system-riscv64` on the host. Until the transcript exists, the `qemu-virt-boot` evidence row in `manifest.json.template` stays `status: missing` and `release-check` reports BLOCKED. No transcript is committed; no `boot_completed: true` is fabricated.                                                                                                                | this variant's `qemu_virt_boot.sh` + `qemu_virt_smoke.py`; consumes systemd `elizaos-ready` line from piece 3                                                                |
| `grub-efi-riscv64-boot`      | Hook `config/hooks/normal/0020-grub-efi-riscv64.hook.binary` stages `BOOTRISCV64.EFI` + `grub.cfg` but no boot transcript is captured. Same external dependency chain as the qemu-virt row.                                                                                                                                                                                                                  | chip-side BSP recipes: [`packages/chip/docs/sw/u-boot/README.md`](../../../../chip/docs/sw/u-boot/README.md), [`packages/chip/docs/android/riscv-bringup.md`](../../../../chip/docs/android/riscv-bringup.md) |
| elizaOS agent binary         | First-boot unit can write `elizaos-ready` even when the agent is absent, but `/opt/elizaos/STATUS_LATER_AGENT_BINARY` stays present until the agent installer hook replaces the placeholder with a real `/opt/elizaos/bin/elizaos`. Until then `elizaos-agent.service` stays `failed (ExecStart not found)`.                                                                                                  | elizaOS agent-release pipeline (`packages/os/linux/agent/`); not in this variant's scope                                                                                    |
| `u-boot-extlinux-boot`       | `not-required` for the GRUB EFI qemu-virt artifact. Staged for distroboot follow-up evidence only; not in scope for the current wave.                                                                                                                                                                                                                                                                        | chip BSP / U-Boot recipe ([`packages/chip/docs/sw/u-boot/README.md`](../../../../chip/docs/sw/u-boot/README.md))                                                            |
| `hardware-board-boot`        | No silicon. No physical board. No host hardware available to this repo. `not-required` for the qemu-virt artifact; for any hardware variant it stays BLOCKED until the chip board bring-up team produces a transcripted boot on real silicon. No hardware claim is made by any of the four landing commits.                                                                                                  | chip board bring-up team (`packages/chip/docs/evidence/linux/`)                                                                                                             |

## Cross-references

- Chip-side integration shortlist (this variant is recorded under
  *OS RV64 bring-up snapshot*):
  [`packages/chip/research/00_integration_shortlist.md`](../../../../chip/research/00_integration_shortlist.md).
- Chip-side tape-out aggregator: `make -C packages/chip tapeout-readiness`
  (39 PASS / 0 FAIL / 8 BLOCKED on 2026-05-19, scripted by
  [`packages/chip/scripts/aggregate_tapeout_readiness.py`](../../../../chip/scripts/aggregate_tapeout_readiness.py)).
- A future top-level `make chip-os-bring-up-status` aggregator (owned
  by the integration aggregator agent, not landed in this wave) will
  combine the chip-side tape-out view with the OS-side `release-check`
  view. Until that lands, run the two gates separately.
- Chip-side software-bsp context the userland consumes:
  [`packages/chip/docs/sw/opensbi/README.md`](../../../../chip/docs/sw/opensbi/README.md),
  [`packages/chip/docs/sw/linux/README.md`](../../../../chip/docs/sw/linux/README.md).
- Sibling Tails-derived variant (do not copy Tails-specific logic):
  [`packages/os/linux/variants/milady-tails/`](../milady-tails/).
- Distribution-channel framing:
  [`packages/os/CLAUDE.md`](../../../CLAUDE.md).
