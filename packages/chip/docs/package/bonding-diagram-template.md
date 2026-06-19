# Bonding diagram template

This template describes the bonding-diagram package that must accompany any
fabricated `eliza_e1_demo` die. It is the human-readable companion to
the machine-readable bonding map at
`package/bonding/e1_demo_bonding.csv`.

A bonding diagram is required by the bonding house and by every PCB review.
Until the package is built, only the die-pad ↔ package-pin ↔ board-net mapping
is fixed; geometry placeholders are explicit so the package vendor can fill
them in without losing pin assignments.

## 1. Required deliverables

A complete bonding diagram release consists of:

1. `package/bonding/e1_demo_bonding.csv` - the canonical pin map, with one
   row per die pad. The column contract is fixed (see section 2).
2. A vendor-provided bonding drawing (PDF or DWG) that shows the die outline,
   pad ring, package leadframe, and every bond wire. Filed under
   `package/bonding/vendor/`.
3. A package mechanical drawing (vendor) - separate from the bonding diagram;
   filed under `package/vendor/`.
4. A bonding worksheet (XLSX or CSV) signed by the bonding house confirming
   wire length, ball/wedge type, and double-bond rules. Filed under
   `package/bonding/vendor/`.
5. A diff against the previous bonding revision when re-releasing.

Until items 2-4 are present, the package release gate in
`pd/padframe/e1_demo_padframe.yaml` stays blocked.

## 2. CSV column contract

`package/bonding/e1_demo_bonding.csv` must contain exactly the following
columns, in this order:

| Column        | Required | Notes                                                                  |
| ------------- | -------- | ---------------------------------------------------------------------- |
| `die_pad`     | yes      | Top-level RTL port name from `rtl/top/e1_chip_top.sv` or padframe-only pad name (e.g. `VDDIO0`). |
| `package_pin` | yes      | Integer pin number on the QFN64 package (1..64).                       |
| `board_net`   | yes      | Net name on `board/kicad/e1-demo`. Must match `package/e1-demo-pinout.yaml`. |
| `type`        | yes      | One of `PWR`, `GND`, `IO`, `RSV`.                                      |
| `notes`       | no       | Free-form. Use to record drive/pull/Schmitt/clock and wire-length hints.|

Validation rules:

- `package_pin` is unique and contiguous over 1..64.
- Every row with `type` in {`PWR`, `GND`, `IO`} that names a die pad in
  `pd/padframe/e1_demo_padframe.yaml` must also appear in `pd/pin_order.cfg`.
- Every row with `type=IO` must correspond to a port in
  `rtl/top/e1_chip_top.sv`.
- `RSV` rows correspond to package pins that are bonded to nothing on the die
  (NC) or reserved for future revisions.

The cross-probe is enforced by `scripts/check_pad_consistency.py`.

## 3. Geometry placeholders

The following geometry fields are NOT in the CSV because they are vendor
outputs, but they MUST appear in the vendor drawing before release:

- Die size (mm x mm).
- Pad pitch (um) and pad bond-window (um).
- Wire length min/max (um) per bond.
- Down-bond locations to the QFN paddle (for substrate / ground stitching).
- Double-bond list for all VDD/VSS pads.
- Bond-wire material and diameter (e.g. 25 um Au, 33 um AuPd).
- Loop height envelope.

## 4. Power/ground bonding policy

- Every IO VDD/VSS pin gets a dedicated wire.
- Every core VDD/VSS pin gets a dedicated wire; double-bond when wire length
  exceeds the vendor's current-density derate at the rail's worst-case
  current taken from the PDN report.
- The QFN paddle is bonded to `GND` through at least two down-bonds and is
  treated as the substrate return.

## 5. Revision history

| Rev | Date       | Author | Notes                                            |
| --- | ---------- | ------ | ------------------------------------------------ |
| 0.1 | 2026-05-17 | (auto) | Initial template aligned to QFN64 placeholder.   |

Every future revision must add a row here and bump the CSV header comment.
