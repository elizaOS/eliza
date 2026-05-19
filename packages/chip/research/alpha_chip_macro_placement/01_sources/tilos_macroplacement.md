# TILOS MacroPlacement

Source: https://github.com/TILOS-AI-Institute/MacroPlacement

Project pages:

- https://tilos-ai-institute.github.io/MacroPlacement/
- https://tilos-ai-institute.github.io/MacroPlacement/Flows/

License: BSD-3-Clause for repository code. Check embedded benchmark and PDK
terms before redistribution.

Local checkout: `external/MacroPlacement`.

## Why it matters

This is the most relevant public companion project for AlphaChip-style macro
placement:

- Public macro-placement benchmarks and reproduced results.
- LEF/DEF and Bookshelf format translators for Circuit Training protobuf input.
- Protobuf-to-LEF/DEF conversion work for returning placements to standard EDA
  flows.
- Evaluator and reproducibility context for comparing AlphaChip, simulated
  annealing, RePlAce/OpenROAD, and commercial-flow references.

## Priority uses for E1

1. Use translators as the E1 LEF/DEF-to-protobuf bridge.
2. Use public Ariane, BlackParrot, MemPool, and NVDLA-style designs for
   pretraining/evaluation before E1-specific data is ready.
3. Mirror their placement acceptance discipline: generated placement is only a
   candidate until standard physical-design flow completion proves quality.

## Local paths of interest

- `external/MacroPlacement/CodeElements/FormatTranslators/src/`
  - `BookshelfToProtobuf.py`
  - `ProtobufToLEFDEF.py`
  - `FormatTranslators.py`
- `external/MacroPlacement/CodeElements/Plc_client/`: reverse-engineered
  open-source placement-cost implementation intended to match Google's
  `plc_client` API.
- `external/MacroPlacement/CodeElements/SimulatedAnnealingGWTW/test/`: public
  CT-compatible `netlist.pb.txt` and `initial.plc` cases.
- `external/MacroPlacement/CodeElements/EvalCT/`: evaluation helper for trained
  Circuit Training policies.

The open `Plc_client` path matters because Google/Farama provide a usable
`plc_wrapper_main` binary, but Google's DREAMPlace tarballs are currently not
publicly retrievable from the documented bucket. TILOS gives us a second path
for proxy-cost validation and converter development while the full CT Docker
training environment is repaired.
