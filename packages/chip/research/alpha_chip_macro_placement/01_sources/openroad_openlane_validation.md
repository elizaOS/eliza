# OpenROAD / OpenLane Validation Stack

Sources:

- OpenLane 2: https://openlane2.readthedocs.io/
- OpenROAD: https://openroad.readthedocs.io/
- OpenROAD-flow-scripts: https://openroad-flow-scripts.readthedocs.io/
- OpenSTA: https://github.com/The-OpenROAD-Project/OpenSTA

## Role

Use AlphaChip only to generate macro placement candidates. Use OpenROAD/OpenLane
as the source of truth for legality, routability, timing, DRC/LVS, antenna,
power, and PDN evidence.

The E1 repo already has the relevant entry points:

- `pd/openlane/config.sky130.json`
- `pd/openlane/config.gf180.json`
- `pd/signoff/manifest.yaml`
- `scripts/run_openlane.sh`
- `scripts/check_pd_signoff.py`

## Candidate acceptance ladder

1. OpenROAD can `read_def` and `write_def` after placement import.
2. OpenLane placement completes with no macro overlap, boundary, halo, or pin
   access failures.
3. Global and detailed routing complete with zero unresolved overflow.
4. OpenSTA setup/hold/slew/cap checks pass or have reviewed waivers.
5. Magic/KLayout DRC, Netgen LVS, antenna checks pass.
6. Power and PDNSim static IR/current reports are archived where available.
7. RTL regression still passes; add GLS once final netlist/SDF exists.
8. `scripts/check_pd_signoff.py` passes against the selected run.

## DEF import plan

Generate `build/alphachip/e1_macro_placement.def`, then test with an
exploratory OpenLane config using:

```json
"FP_DEF_TEMPLATE": "dir::../../build/alphachip/e1_macro_placement.def"
```

Do not use AlphaChip proxy reward as a release gate.
