# Release evidence template

This template defines the manifest structure for a release-blocker-free
tapeout package. It is the parent of the PD signoff evidence
(`docs/pd/signoff-evidence-template.md`) and of the bonding diagram
(`docs/package/bonding-diagram-template.md`).

A release is "tapeout-ready" only when every section below is filled in with
real artifacts and every `release_gates` flag is `unblocked` in the
corresponding machine-readable manifest.

## File layout

```
build/release/<RELEASE_ID>/
  manifest.yaml                # top-level manifest matching this template
  pdk/                         # PDK install snapshot or version-pinned reference
  tools/                       # tool versions used for every step
  pd_signoff/<RUN_ID>/         # padless macro signoff (see signoff-evidence-template.md)
  pd_padframe/<RUN_ID>/        # padframe-inclusive signoff
  package/
    vendor-drawing.pdf         # package mechanical drawing from the vendor
    bonding-diagram.pdf        # bonding diagram from the bonding house
    bonding-worksheet.csv      # signed worksheet (wire length, double-bond list)
    ibis/<DESIGN>.ibs          # IBIS model handed to board SI/PI
  board/
    si_pi_report.pdf           # board-level SI/PI sign-off
    pdn_report.pdf             # board-level PDN sign-off
    first_article_currents.csv # per-rail current measured at first article
  evidence/
    pad_consistency.json       # output of scripts/check_pad_consistency.py
    padframe_check.json        # output of scripts/check_padframe_contract.py
    signoff_check.json         # output of scripts/check_pd_signoff.py
```

## Required manifest fields

The top-level `manifest.yaml` must include at minimum:

```yaml
release_id: <string>             # e.g. eliza_e1_demo_<UTC timestamp>
release_date: <ISO-8601>
chip: eliza_e1_demo

pdk:
  name: <Sky130|GF180MCU|SG13G2|...>
  version: <pinned commit or release tag>
  install_path: <relative path under build/release/<RELEASE_ID>/pdk/>

tools:
  openlane2: <version>
  openroad: <version>
  yosys: <version>
  magic: <version>
  netgen: <version>
  klayout: <version>

padframe:
  drc_report: pd_padframe/<RUN_ID>/reports/drc.rpt
  lvs_report: pd_padframe/<RUN_ID>/reports/lvs.rpt
  pad_cells:
    - { class: io_vdd,   count: 5, library: <pad-lib> }
    - { class: io_vss,   count: 5, library: <pad-lib> }
    - { class: core_vdd, count: 4, library: <pad-lib> }
    - { class: core_vss, count: 4, library: <pad-lib> }
    - { class: corner,   count: 4, library: <pad-lib> }
    - { class: esd_clamp, count: <N>, library: <pad-lib> }
  esd_targets:
    hbm_kv: 2
    cdm_v: 250

package:
  vendor: <vendor name>
  drawing: package/vendor-drawing.pdf
  body: qfn64
  paddle_bonding: package/bonding-diagram.pdf

bonding:
  diagram: package/bonding-diagram.pdf
  worksheet: package/bonding-worksheet.csv
  csv: package/bonding/e1_demo_bonding.csv
  bonding_house: <vendor name>

ibis:
  model: package/ibis/eliza_e1_demo.ibs
  corner_count: <N>

board:
  si_pi_report: board/si_pi_report.pdf
  pdn_report: board/pdn_report.pdf
  first_article_currents: board/first_article_currents.csv
  current_limits:
    +3V3_io:   { typ_mA: <N>, max_mA: <N> }
    +1V8_core: { typ_mA: <N>, max_mA: <N> }

evidence:
  pad_consistency: evidence/pad_consistency.json
  padframe_check: evidence/padframe_check.json
  pd_signoff_check: evidence/signoff_check.json

release_gates:
  padframe_release: unblocked
  package_release: unblocked
  board_fabrication_release: unblocked
  tapeout: unblocked
```

## Required attached evidence

The release is incomplete unless every artifact below is present and
nonempty:

- [ ] PDK install snapshot or pinned PDK version reference.
- [ ] Tool version manifest with exact hashes for OpenLane2, OpenROAD, Yosys,
      Magic, Netgen, KLayout.
- [ ] Padframe-inclusive DRC and LVS reports, both clean (or with H-risk-free
      waivers only).
- [ ] Padless macro signoff folder per `docs/pd/signoff-evidence-template.md`.
- [ ] Package vendor mechanical drawing (PDF or DWG).
- [ ] Bonding diagram (PDF) from the bonding house.
- [ ] Bonding worksheet (CSV/XLSX) signed by the bonding house.
- [ ] IBIS model per output buffer family, with at least min/typ/max corners.
- [ ] Board SI/PI report (clock, debug, GPIO trace impedance, eye margin).
- [ ] Board PDN report (decoupling, plane impedance, target rail noise).
- [ ] First-article current measurements per rail vs. manifest limits.
- [ ] `scripts/check_pad_consistency.py` output committed to
      `evidence/pad_consistency.json` with `ok: true`.
- [ ] `scripts/check_padframe_contract.py` output committed similarly.
- [ ] `scripts/check_pd_signoff.py` output committed similarly.

## Release gate semantics

Each `release_gates` flag may only be `unblocked` once its evidence is in
place:

- `padframe_release` - requires the `padframe.*` and `pd_padframe/*` sections.
- `package_release` - requires the `package.*` and `bonding.*` sections plus
      a vendor sign-off email referenced in `notes`.
- `board_fabrication_release` - requires every `board.*` artifact and a
      first-article rail-current measurement within the manifest limits.
- `tapeout` - requires all three above and the full `pd_signoff/*` tree.

Any flag whose evidence is missing must be set to `blocked` with a `reason:`
field. The release manifest checker treats a missing reason as a hard error.
