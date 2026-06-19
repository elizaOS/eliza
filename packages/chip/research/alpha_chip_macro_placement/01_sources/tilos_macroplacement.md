# TILOS MacroPlacement

Source: https://github.com/TILOS-AI-Institute/MacroPlacement

Project pages:

- https://tilos-ai-institute.github.io/MacroPlacement/
- https://tilos-ai-institute.github.io/MacroPlacement/Flows/

License: BSD-3-Clause for repository code. Check embedded benchmark and PDK
terms before redistribution.

Local checkout: `external/repos/tilos-macroplacement/payload`
(`CodeElements/` mirrors the upstream `CodeElements/` tree).

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

(All under `external/repos/tilos-macroplacement/payload/CodeElements/`.)

- `FormatTranslators/src/`
  - `BookshelfToProtobuf.py`
  - `ProtobufToLEFDEF.py`
  - `FormatTranslators.py`
- `Plc_client/plc_client_os.py`: BSD-3-Clause reverse-engineered open-source
  placement-cost implementation matching Google's `plc_client` API. Implements
  `get_cost` (wirelength), `get_congestion_cost`, and `get_density_cost` with no
  `plc_wrapper_main` dependency.
- `Plc_client/test/ariane/`: CT-compatible `netlist.pb.txt` + `initial.plc`.

## Open proxy-cost path (verified 2026-05-21)

`plc_client_os` is the fully-open replacement for the AlphaChip reward
`wirelength + 0.5*congestion + 0.5*density`. `scripts/alphachip/open_proxy_cost.py`
drives it natively on CPU (~13 s on Ariane) and, with `--compare-binary`, cross-
checks against the genuine `plc_wrapper_main`. Measured fidelity on the Ariane
`initial.plc`:

| Term       | Real binary       | `plc_client_os`   | Delta             |
| ---------- | ----------------- | ----------------- | ----------------- |
| wirelength | 0.0501866077      | 0.0501866077      | -6e-12 (bit-match)|
| congestion | 0.9411796212      | 0.9845656490      | +4.6%             |
| density    | 0.7564011220      | 0.7500617686      | -0.84%            |
| proxy      | 0.8989769793      | 0.9175003165      | +2.1%             |

Wirelength is near bit-exact; density within ~1%; congestion (stochastic fast-
router) within ~5%. The open client is a faithful but not bit-exact reward
signal: usable for an open RL loop and for cross-validation, not for a
last-digit reproduction claim against `plc_wrapper_main`.

See `docs/toolchain/alphachip-checkpoint-blocker.md` for the closed-binary
status and the lawful Farama mirror that supplies a runnable `plc_wrapper_main`.
