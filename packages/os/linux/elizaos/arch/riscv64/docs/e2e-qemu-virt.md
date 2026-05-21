# elizaOS Debian RISC-V 64 — end-to-end qemu-virt runbook

This runbook walks a fresh contributor from a clean checkout to a
transcripted **QEMU `virt`** boot of the elizaOS Debian RISC-V 64 live
ISO, and then through the fail-closed release-manifest gate that
guards promotion.

> **Honesty preamble.** The live ISO build, the qemu-virt boot, and
> the elizaOS agent binary are all **external dependencies** of this
> repository. Until each of them produces a hash-matched artifact that
> this runbook can point at, the release-manifest gate for this
> variant stays `BLOCKED`. No step below is allowed to silently
> succeed against a placeholder. The validator `scripts/check_release_manifest.py`
> exists to enforce that.
>
> No claim of the form "elizaOS runs on chip" is made anywhere in this
> repository unless **both** the qemu-virt boot transcript and the chip
> evidence manifest attest to it. The runbook below produces only the
> first half of that pair.

## Host prerequisites

The build is containerised; the qemu boot is not. You need:

- A **Debian / Ubuntu x86_64 build host** (the same host can run the
  Docker build and the qemu boot).
- ~30 GB free disk for the live-build chroot + the ISO + qemu state.
- ~8 GB RAM headroom for `mksquashfs` plus 2 GB for the qemu guest.
- Local packages on the host:
  - `docker` (or a rootless equivalent) — runs the builder image.
  - `qemu-system-riscv64` (`apt install qemu-system-misc`) — runs the
    boot under `-machine virt`.
  - `qemu-user-static`, `binfmt-support` — needed by `debootstrap` /
    `live-build` inside the container to populate the riscv64 chroot.
  - `live-build`, `debootstrap` — only required if you also want to
    run `lb config` on the host. The container ships these too.
  - `python3` (>= 3.11) — runs the validator and the boot wrapper.
  - `make` — drives the variant Makefile.
- No network policy blocking the Debian Trixie riscv64 mirror
  (`deb.debian.org/debian` + `security.debian.org/debian-security`).

The validator script (`scripts/check_release_manifest.py`) only depends
on `jsonschema` from the Python standard ecosystem and on the standard
library. The unit-test file additionally uses `hypothesis`; both are
pinned in this variant's `requirements.txt`.

Install those optional validation dependencies when you want full schema
validation and property tests:

```sh
make -C packages/os/linux/variants/elizaos-debian-riscv64 deps
```

Without those dependencies, the release gate does not crash: missing
`jsonschema` is reported as `BLOCKED` evidence infrastructure, and the
Hypothesis mutation tests are skipped with an explicit message.

## Step 0 — sanity check

From the repo root:

```sh
cd packages/os/linux/variants/elizaos-debian-riscv64
make help
```

`make help` lists every target this variant exposes. None of those
targets perform a destructive write outside the variant directory.

## Step 1 — build the builder image

```sh
docker build -t elizaos-debian-riscv64-builder \
    packages/os/linux/variants/elizaos-debian-riscv64/
```

Equivalent shortcut:

```sh
make -C packages/os/linux/variants/elizaos-debian-riscv64 build-image
```

Expected duration: **5 – 15 min** on a warm Docker daemon, longer
on the first run (apt mirror cold cache).

Outputs: a local Docker image `elizaos-debian-riscv64-builder:latest`.

## Step 2 — build the live ISO

```sh
mkdir -p packages/os/linux/variants/elizaos-debian-riscv64/out
docker run --rm --privileged \
    -v "$PWD/packages/os/linux/variants/elizaos-debian-riscv64/out:/work/out" \
    elizaos-debian-riscv64-builder
```

Equivalent shortcut:

```sh
make -C packages/os/linux/variants/elizaos-debian-riscv64 build
```

Expected duration: **45 – 90 min** on a warm builder image and a
warm apt mirror, longer on the first run.

Outputs: `out/elizaos-debian-riscv64-<ts>.iso` plus a sibling
`out/elizaos-debian-riscv64-<ts>.iso.sha256`.

If `lb build` fails or refuses to run, the variant is still on the
skeleton Wave 2B-B1 gate. Surface that as a `BLOCKED` row in the
manifest's `evidence[]` array; do **not** invent a fake ISO.

## Step 3 — boot the ISO under QEMU `virt`

```sh
packages/os/linux/variants/elizaos-debian-riscv64/scripts/qemu_virt_boot.sh \
    --iso       packages/os/linux/variants/elizaos-debian-riscv64/out/elizaos-debian-riscv64-<ts>.iso \
    --evidence  packages/os/linux/variants/elizaos-debian-riscv64/evidence/qemu_virt_boot.json \
    --transcript packages/os/linux/variants/elizaos-debian-riscv64/evidence/qemu_virt_boot.transcript.log
```

Equivalent shortcut (boots the newest ISO in `out/` and writes evidence
under `<variant>/evidence/`):

```sh
make -C packages/os/linux/variants/elizaos-debian-riscv64 qemu-boot
```

The boot harness writes a JSON evidence file conforming to the
`eliza.os.linux.qemu_virt_boot.v1` schema (defined in
`scripts/qemu_virt_smoke.py`). Required fields include:

```json
{
  "schema": "eliza.os.linux.qemu_virt_boot.v1",
  "claim_boundary": "qemu_virt_boot_transcript_evidence_only_no_silicon_or_physical_board_claim",
  "iso_path":          "<absolute path to .iso>",
  "iso_sha256":        "<64 hex chars>",
  "transcript_path":   "<absolute path to .log>",
  "transcript_sha256": "<64 hex chars>",
  "memory_mb": 4096, "cpus": 4, "timeout_s": 600, "duration_s": <int>,
  "start_utc": "<ISO 8601 UTC>",
  "qemu_exit_code": 0,
  "u_boot_path": null,
  "boot_completed": true,
  "markers_found":             ["Linux version", "systemd[1]: System Initialized", ...],
  "markers_missing":           [],
  "forbidden_markers_present": [],
  "provenance": "qemu_virt"
}
```

The transcript log must additionally contain the literal marker
`elizaos-firstboot-ready` — the elizaOS first-boot unit prints that line once
OS userland initialization has completed. Agent liveness is a separate
`elizaos-agent-ready` marker and is not proven by the qemu-virt release gate.
If the first-boot marker is missing the release-manifest gate (Step 4) reports
FAIL, not PASS.

Expected duration: **2 – 6 min** for an end-to-end boot once the
guest kernel is cached. Allocate at least 2 GB of guest RAM and one
vCPU.

## Step 4 — fail-closed release-manifest gate

After Step 3 lands a hash-matched evidence file, run:

```sh
python3 packages/os/linux/variants/elizaos-debian-riscv64/scripts/check_release_manifest.py
```

Equivalent shortcut:

```sh
make -C packages/os/linux/variants/elizaos-debian-riscv64 release-check
```

What the validator does:

1. Loads either `manifest.json` (preferred) or `manifest.json.template`.
2. Validates it as a single `artifacts[]` entry of
   `packages/os/release/schema/elizaos-os-release-manifest.schema.json`.
3. For each required evidence row, asserts `status: collected` is
   present **once the artifact has been promoted past `planned`**.
4. Loads the qemu-virt evidence JSON (path from `evidence[].path`).
5. Asserts `boot_completed === true` and that `iso_sha256` matches
   the `sha256` on the parent manifest entry.
6. Asserts the transcript referenced by `transcript_path` contains
   the literal `elizaos-firstboot-ready` marker.
7. Aggregates the result. `STATUS: BLOCKED` is informational;
   `STATUS: FAIL` is a release blocker.

For a release build, use the strict variant:

```sh
make -C packages/os/linux/variants/elizaos-debian-riscv64 release-check-strict
```

`--strict` escalates every `BLOCKED` to `FAIL`. Use it in the release
pipeline; do not use it on a freshly-cloned checkout where the
external dependencies (mirror, ISO, agent) are still pending.

To run the unit tests for the validator itself:

```sh
make -C packages/os/linux/variants/elizaos-debian-riscv64 release-check-test
```

## Expected timing

| Step | Cold | Warm |
|------|------|------|
| 1. Builder image | 10 – 15 min | 1 – 2 min |
| 2. Live ISO | 75 – 90 min | 45 – 60 min |
| 3. QEMU boot | 5 – 6 min | 2 – 3 min |
| 4. Manifest gate | < 5 s | < 5 s |

## Known-BLOCKED items

These are tracked in the manifest as `evidence[].status: missing`
until external work lands. The validator surfaces them as `BLOCKED`
in the default mode and `FAIL` under `--strict`. None of them are
in scope for this runbook — each is a separate workstream.

| Evidence row              | Owner    | Blocks promotion past |
|---------------------------|----------|----------------------|
| `qemu-virt-boot`          | this runbook + `qemu_boot_harness` sibling | `planned`     |
| `u-boot-extlinux-boot`    | chip BSP / U-Boot recipe                   | `candidate`   |
| `grub-efi-riscv64-boot`   | chip BSP / GRUB EFI recipe                 | `candidate`   |
| `hardware-board-boot`     | chip board bring-up team                   | `published`   |

Other external dependencies that this runbook does **not** unblock:

- **Debian Trixie riscv64 mirror availability.** The build pulls
  packages from `deb.debian.org`. If the mirror is offline or the
  riscv64 set is incomplete, `lb build` exits non-zero. The validator
  has no way to distinguish a mirror outage from a real config break;
  the failing `lb build` log is the source of truth.
- **elizaOS agent binary publication.** The first-boot marker can appear before
  the agent exists. Until the RV64 image packages `/opt/elizaos/bin/elizaos`,
  no `elizaos-agent-ready` marker or agent health evidence should be claimed.
- **Real board boot.** The qemu-virt boot is necessary but not
  sufficient. The `hardware-board-boot` row stays BLOCKED until the
  chip team produces a transcripted boot on real silicon.

## Failure mode reference

| Symptom                                  | What the validator prints                                                |
|------------------------------------------|--------------------------------------------------------------------------|
| No `manifest.json`, only the template    | `BLOCKED: manifest.json not filled; using manifest.json.template`        |
| `manifest.json` schema-invalid           | `FAIL: manifest does not match elizaos-os-release-manifest.schema.json`  |
| Evidence row missing the JSON file       | `BLOCKED: evidence file not present: <path>`                             |
| `boot_completed=false` in evidence       | `FAIL: qemu-virt boot did not complete`                                  |
| `iso_sha256` mismatch                    | `FAIL: iso_sha256 mismatch between manifest and evidence`                |
| Transcript missing `elizaos-firstboot-ready`       | `FAIL: transcript missing required marker: elizaos-firstboot-ready`                |
| Schema OK, every row collected, marker present | `PASS: release manifest gate ok`                                   |

`PASS` from this runbook means the qemu-virt half of the promotion
contract is satisfied. It does **not** mean the variant is ready to
ship — the remaining `BLOCKED` rows (extlinux, grub-efi, hardware
board) still need their own evidence.
