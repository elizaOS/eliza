# TSMC N2P stub — primary 2028 production target (BLOCKED)

This directory is a **fail-closed evidence file** for TSMC N2P. It records the
selection of N2P as the project's primary 2028 production target, the
procurement preconditions that must be satisfied before any signoff artifact
can be produced at N2P, and the forbidden-claim list.

It does **not** contain any TSMC N2P PDK data, library, Liberty, GDS, LEF,
extraction view, SRAM macro, PHY hard-IP, or signoff report. Those are all
locked behind the TSMC OIP / NDA agreement that does not exist for this
project. Checking any of them in would be a license violation and is also
forbidden by `claim_rules` in `pd/openlane/portability-index.yaml`.

See:
- `pd/n2p-stub/access-gate.yaml` — machine-readable procurement gate
- `pd/corner-manifests/tsmc-n2p.yaml` — corner methodology after unblock
- `pd/library-manifests/tsmc-n2p.yaml` — library methodology after unblock
- `docs/pd/process-node-selection.md` — N2P primary / A14 stretch / Intel 14A 2nd source rationale
- `docs/evidence/process/pdk-access-gate.yaml` — top-level procurement evidence file
