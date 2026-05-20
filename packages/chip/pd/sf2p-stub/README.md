# Samsung SF2P stub — backup 2028 target (BLOCKED)

Fail-closed evidence file for Samsung SF2P (3rd-gen MBCFET GAA, frontside).
SF2P is documented as a backup 2028 target if both TSMC (N2P / A14) and Intel
(14A) paths are blocked.

Samsung SF3 yield issues limited external uptake; SF1.4 slipped to 2028-2029.
For external customers, Samsung SF2P is realistic but less proven than TSMC at
the equivalent node. SF2Z (BSPDN) arrives 2027 and is a separate gate.

No SF2P PDK data, library, GDS, LEF, extraction view, SRAM macro, PHY hard-IP,
or signoff report is or will be checked in until a Samsung Foundry SAFE program
or NDA agreement is in place.

Related:
- `pd/corner-manifests/samsung-sf2p.yaml`
- `pd/library-manifests/samsung-sf2p.yaml`
- `docs/pd/process-node-selection.md`
- `docs/evidence/process/pdk-access-gate.yaml`
