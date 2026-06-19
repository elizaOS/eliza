# PD signoff evidence template

A tapeout-ready padframe-inclusive macro must produce every artifact in this
list before the `pd/signoff/manifest.yaml` gate is allowed to flip to
unblocked. The list is foundry-agnostic; the actual file extensions vary
slightly between OpenROAD/OpenLane2 and a commercial flow, but the artifact
classes do not.

Every entry below is recorded relative to `build/pd/signoff/<RUN_ID>/`,
where `<RUN_ID>` is the OpenLane/OpenROAD run name (timestamped). The
machine-readable manifest references these paths through globs; this document
is the human-readable mirror that reviewers tick off during signoff review.

## Path conventions

```
build/pd/signoff/<RUN_ID>/
  gds/<DESIGN>.gds              # final routed GDS or OASIS
  def/<DESIGN>.def              # final DEF
  netlist/<DESIGN>.v            # gate-level netlist (post-route)
  sdc/<DESIGN>.sdc              # final SDC
  spef/<DESIGN>.<corner>.spef   # one SPEF per signoff RC corner
  sdf/<DESIGN>.<corner>.sdf     # one SDF per signoff RC corner
  reports/drc.rpt               # foundry DRC summary
  reports/lvs.rpt               # LVS summary, including waivers count
  reports/antenna.rpt           # antenna DRC summary
  reports/sta/<corner>.rpt      # one STA per PVT corner
  reports/power.rpt             # post-route power per scenario
  reports/ir_drop.rpt           # static IR-drop summary; dynamic if available
  reports/em.rpt                # electromigration check on signal + PG
  reports/density.rpt           # metal density per layer; fill summary
  reports/congestion.rpt        # GR congestion per direction/layer
  reports/utilization.rpt       # placement utilization
  manifest.yaml                 # tool versions + checksum of every artifact
  waivers/<check>.waiver        # one waiver file per non-clean check
```

## Artifact checklist

Tick each box when the corresponding file is present, nonempty, and contains
the expected "clean" marker (or has an accompanying waiver). The check is
also enforced by `scripts/check_pd_signoff.py`.

### Layout

- [ ] `gds/<DESIGN>.gds` - final routed GDS/OASIS.
- [ ] `def/<DESIGN>.def` - final DEF with placement, routing, vias.
- [ ] `netlist/<DESIGN>.v` - post-route gate netlist matching the DEF.

### Timing

- [ ] `sdc/<DESIGN>.sdc` - final SDC handed to STA.
- [ ] `spef/<DESIGN>.<corner>.spef` - one per RC corner (typ/min/max).
- [ ] `sdf/<DESIGN>.<corner>.sdf` - one per RC corner (typ/min/max).
- [ ] `reports/sta/<corner>.rpt` - one STA per PVT corner. WNS/TNS must be
      non-negative or covered by an explicit waiver.

### Physical verification

- [ ] `reports/drc.rpt` - clean per the foundry DRC deck. Any non-clean check
      requires a `waivers/drc-*.waiver`.
- [ ] `reports/lvs.rpt` - clean LVS against the gate netlist + DEF.
- [ ] `reports/antenna.rpt` - clean antenna; diode insertions are documented.

### Power and reliability

- [ ] `reports/power.rpt` - post-route power per scenario (idle, peak, target).
- [ ] `reports/ir_drop.rpt` - static IR-drop within the rail margin. Include
      dynamic IR-drop for the highest-activity scenario when the flow supports it.
- [ ] `reports/em.rpt` - electromigration on signal and PG; calls out any
      hotspot above the foundry derate.

### Floorplan quality

- [ ] `reports/density.rpt` - metal density per layer satisfies the foundry
      min/max; fill is reported separately.
- [ ] `reports/congestion.rpt` - GR congestion per direction/layer. Hotspots
      called out with a fix plan or accepted as a waiver.
- [ ] `reports/utilization.rpt` - placement utilization within the floorplan
      target band.

### Manifest

- [ ] `manifest.yaml` - PDK name and version, OpenLane/OpenROAD versions,
      Magic/KLayout/Netgen versions, SHA-256 of every artifact above, and an
      explicit `release_gates:` block setting `padframe_signoff: unblocked`.

## Padframe-inclusive run

The standard signoff above is for the padless macro `e1_soc_top`. The
padframe-inclusive top `e1_chip_top` requires a SEPARATE run with its own
`<RUN_ID>` directory under the same conventions. The padframe-inclusive run
adds:

- [ ] Foundry IO/ESD/corner cell LEF and Liberty vendored and referenced.
- [ ] Pad ring DRC clean (or waived) against the foundry deck.
- [ ] Padframe-inclusive LVS clean against the full top netlist.
- [ ] PDN simulation that includes pad-resistance and bond-wire inductance
      using values from the bonding diagram.

Both runs must exist and both must be clean before
`pd/signoff/manifest.yaml` flips its `release_gates` to unblocked.

## Waivers

Every non-clean check needs a waiver file in `waivers/`. The waiver must
include:

- Check name, rule, and triggering location.
- Justification (geometry-only, library cell, intentional override).
- Owner and review date.
- Risk classification (`L`, `M`, `H`). `H` waivers block release.

## Cross-references

- `pd/signoff/manifest.yaml` - machine-readable artifact gate.
- `docs/pd/pad-cell-selection-criteria.md` - PDK eligibility matrix.
- `docs/manufacturing/release-evidence-template.md` - parent release manifest.
- `docs/tapeout-checklist/e1-chip.md` - human review checklist.
