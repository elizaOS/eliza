# LPDDR and DRAM landscape for a 2028 mobile AI SoC

Date: 2026-05-19

This document synthesizes the publicly available DRAM landscape that constrains
external memory choices for the 2028 mobile AP target in
`docs/spec-db/npu-2028-target.yaml`. It treats every vendor number as a target
or directional value; nothing here is E1 evidence.

## Bandwidth budget the E1 needs to meet

From the contract:

| Quantity | Target |
| --- | ---: |
| `external_memory_bandwidth_gbps_min` | 180 GB/s |
| Sustained DRAM bandwidth (uma-dram-evidence-gate) | 120 GB/s |
| Sustained measured target in compute-silicon work order | 208 GB/s |
| Random-read p95 latency target | <= 120 ns |
| Shared system cache | >= 32 MiB |
| Local NPU SRAM bandwidth | >= 20 TB/s |

Mobile AP precedents at 2026 ship LPDDR5X-8533/9600/10700 with a 64-bit
package interface, which gives peak package bandwidth of approximately
`64 / 8 * 8533 = 68.3 GB/s` at 8533 MT/s, `76.8 GB/s` at 9600 MT/s, and
`85.6 GB/s` at 10700 MT/s. To reach 180 GB/s peak, the chip must either widen
the package interface beyond 64 bits, move to LPDDR6, or step up to a stacked
solution (HBM-class). All three are realistic for 2028; only some are realistic
for a phone-class thermal envelope and BoM.

## LPDDR generations

### LPDDR5 / LPDDR5X (JESD209-5C)

LPDDR5 is the 2020-2024 mobile baseline. Devices are organized as x16 with two
8-bit pseudo-channels (LPDDR5) or x16/x8 with sub-channelization. LPDDR5X
extends per-pin signaling up to 8533 MT/s. The standard adds link ECC (write
CRC, read CRC, and write-X), DBI-DC, NT-ODT, and DVFSC for fast frequency
shifts. Mobile APs typically combine LPDDR5X with a multi-rank PoP or in-package
configuration, with one to four devices per package.

Bandwidth math for a 64-bit package:

| Per-pin rate (MT/s) | Package GB/s (x64) |
| ---: | ---: |
| 6400 | 51.2 |
| 7500 | 60.0 |
| 8533 | 68.3 |
| 9600 | 76.8 |

For a 96-bit or 128-bit package (Snapdragon X2 Elite and AI PC class):

| Per-pin rate (MT/s) | Package GB/s (x128) |
| ---: | ---: |
| 8533 | 136.5 |
| 9600 | 153.6 |
| 10700 | 171.2 |

A 128-bit LPDDR5X-10700 channel sits just below the 180 GB/s target, so even a
laptop-class LPDDR5X is not by itself sufficient for the 2028 phone-class peak
contract. This is why every 2028 mobile competitor (Snapdragon 8 Elite Gen 5,
Dimensity 9500, Exynos 2600) pushes either a wider bus, LPDDR5T/5U interim, or
an LPDDR6 step.

### LPDDR5T / LPDDR5U (vendor extensions inside JEDEC update path)

Samsung, SK hynix, and Micron announced LPDDR5X parts in the 9.6-10.7 Gb/s
range over 2024-2025. SK hynix calls 9.6 Gb/s LPDDR5T; Samsung announced
10.7 Gb/s using a 12 nm-class node with 25% better power efficiency than the
8.5 Gb/s LPDDR5X baseline. These remain inside the JESD209-5 update family.
They give a phone roughly a 9.6-10.7 Gb/s per-pin headline, which on a 64-bit
package gives 76.8-85.6 GB/s peak. For a "performance-heavy" 2028 AP, that is
still 50-55% short of the 180 GB/s peak target.

### LPDDR6 (JESD209-6, pre-publication)

LPDDR6 is in active JEDEC standardization in 2026. Public announcements indicate:

- Per-pin rate targets in the 10.667-14.4 Gb/s range, with first products
  targeting 10.667-12.8 Gb/s and vendor plans extending toward 14.4 Gb/s.
- A new sub-channel architecture (24-bit sub-channel, x4-style organization)
  rather than the LPDDR5 x16 with two 8-bit pseudo-channels.
- On-die ECC and link error correction integrated by default.
- New CA (command-address) bus structure and training.

For a phone-class package, LPDDR6 at 12.8 Gb/s on a 64-bit-equivalent interface
yields about `64 / 8 * 12800 = 102.4 GB/s`. Two-die-per-package (effective
128-bit) at 12.8 Gb/s yields 204.8 GB/s, which clears the 180 GB/s peak and
approaches the 208 GB/s sustained target from
`docs/architecture-optimization/compute-silicon.md` (peak vs sustained gap
remains, see "Sustained vs peak" below). LPDDR6 is the most plausible mainline
choice for a 2028 phone-class AP.

### DDR5 (JESD79-5C)

DDR5 is included only as a server-side reference. It is not viable for a
phone-class AP because of socket-style DIMM signaling, PMIC per-DIMM, and higher
idle power. The relevant lessons for E1 are RFM (Refresh Management), PRAC,
and per-bank refresh counters, which feed into RowHammer mitigation policy.

### HBM3 / HBM3E / HBM4

HBM is not a mainline phone-class option in 2028. It is included because:

- HBM3 (JESD238) standardized at 6.4 Gb/s per pin, 16 channels per stack, up to
  819 GB/s per stack.
- HBM3E pushes per-pin to 9.2-9.8 Gb/s, giving up to ~1.2 TB/s per stack.
  Vendors: Micron HBM3E 24 GB / 36 GB, SK hynix 12-Hi/16-Hi, Samsung Shinebolt.
- HBM4 (published 2025) doubles the per-stack interface to 2048 bits and
  targets up to 8 Gb/s per pin baseline, with capacity up to 64 GB per stack
  (16-Hi).

For the 2028 phone-class target, HBM is not on the table for thermal and BoM
reasons. The relevant pattern transfer is the HBM coherent fabric and
bank-level scheduling lessons (see `coherency_and_noc.md` and
`bandwidth_compression_and_qos.md`). The HBM-PIM and AiM near-memory threads
also matter, even if E1 does not deploy stacked compute (see
`sram_and_local_memory.md`).

## Sustained vs peak bandwidth

Peak `data-rate * bus-width` is an upper bound, not a sustained number. Realistic
sustained efficiency for an aggressively scheduled controller on contended
mobile traffic is in the 60-75% range, dropping further when refresh, write-read
turnaround, bank conflicts, and QoS arbitration are included. Concretely:

| Scenario | Peak GB/s | Eff (%) | Sustained GB/s |
| --- | ---: | ---: | ---: |
| 64-bit LPDDR5X-8533 | 68.3 | 70 | 47.8 |
| 64-bit LPDDR5X-9600 | 76.8 | 70 | 53.8 |
| 64-bit LPDDR6-12800 | 102.4 | 70 | 71.7 |
| 128-bit LPDDR5X-9600 | 153.6 | 70 | 107.5 |
| 128-bit LPDDR6-12800 | 204.8 | 75 | 153.6 |
| 128-bit LPDDR6-14400 | 230.4 | 75 | 172.8 |

Reaching the 208 GB/s sustained target from the compute-silicon work order
implies a 128-bit-class LPDDR6 channel at around 12.8-14.4 Gb/s with high
controller efficiency, on top of a system-level cache that absorbs hot reuse so
the DRAM-side traffic is the cold miss tail.

## Refresh, RowHammer, ECC

- RowHammer: documented since 2015; modern LPDDR5/DDR5 mitigations include
  TRR (Target Row Refresh), RFM (Refresh Management), and Probabilistic
  Adjacent Row Activation (PRAC). The threat extends to LPDDR5/5X; LPDDR6 keeps
  the refresh-management surface area but adds on-die ECC by default.
- On-die ECC: LPDDR5/5X already include on-die single-bit ECC (vendor-defined
  internal); LPDDR6 standardizes on-die ECC. This protects against single-bit
  retention/cell failures but does NOT mitigate RowHammer-induced multi-bit
  attacks. Link ECC (CRC) is separate.
- LPDDR5 link ECC: write CRC and read CRC are defined per JESD209-5. Mobile APs
  typically enable CRC for system memory accesses where bit-error budget
  matters; AI inference traffic in particular benefits because silent bit flips
  in weight memory can degrade accuracy without any obvious failure.
- For E1 evidence: any LPDDR claim must come with refresh policy (TRR/RFM),
  link CRC enable state, on-die ECC, and a row-hammer mitigation plan recorded
  in the boot transcript.

## Power policy

- Partial Array Self-Refresh (PASR): per-bank-group masked refresh, saves
  static refresh power when system can guarantee data in masked rows is dead.
- Deep Power Down (DPD): all banks unrefreshed; data is lost. Used for true
  idle.
- DVFSC / DVFSM: in-band frequency switching commands for LPDDR5/5X. Mobile
  APs use this for camera idle, display idle, and audio-only mailbox modes.
- LPDDR6 keeps these and adds finer-grained sub-channel idling.

For E1 evidence the boot/runtime must show the DRAM controller exposing
counters for time-in-state for the active, idle, self-refresh, and PASR
states, plus a measured-vs-target DRAM power line item.

## Per-vendor 2026 mobile DRAM positioning

| Vendor | Headline part | Per-pin | Process | Note |
| --- | --- | ---: | --- | --- |
| Samsung | LPDDR5X | 10.7 Gb/s | 12 nm-class | 25% better power efficiency vs 8.5 Gb/s LPDDR5X |
| SK hynix | LPDDR5T | 9.6 Gb/s | 1b/1c-class | JEDEC-aligned LPDDR5 update path, 77 GB/s x64 |
| Micron | LPDDR5X (1-gamma) | 9.6 Gb/s | 1-gamma EUV | "1-gamma" mobile DRAM node, baseline for LPDDR6 step |
| Samsung / SK hynix / Micron | LPDDR6 | 10.7-14.4 Gb/s | next-gen | pre-publication JESD209-6, announcements only |

## Implications for E1 2028 contract

The smallest viable configuration that even comes close to the 180 GB/s peak
gate uses LPDDR6 at >= 12 Gb/s per pin on a 128-bit-equivalent package. A 96-bit
LPDDR6-14400 package (`96 / 8 * 14400 = 172.8 GB/s` peak) is just barely short.
A 64-bit LPDDR5X-10700 package (~85.6 GB/s peak) is roughly half the target and
must be rejected for E1 release-grade claims. The architecture should also
reserve a system-level cache budget (>=32 MiB, see `coherency_and_noc.md`) to
turn DRAM bandwidth into effective bandwidth for AI workloads.

The recommendation for the implementation document (`03_implementation/`) is:

- LPDDR6 controller and PHY as the target external memory subsystem.
- 96-128-bit package interface (two or four LPDDR6 sub-channel devices).
- Link CRC and on-die ECC mandatory.
- TRR + RFM RowHammer policy with counters exposed to firmware.
- DRAM controller QoS classes for camera, display, modem, audio, NPU, CPU, GPU,
  with dedicated isolation guarantees described in `bandwidth_compression_and_qos.md`.
