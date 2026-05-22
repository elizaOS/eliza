# Dataset cards — converted AI-EDA corpora (2026-05-21, Linux host)

All payloads live under ignored `external/**/payload/`; only metadata,
manifests, hashes, and converted internal records are tracked. Every converted
record carries source hashes, schema version, split id, and a
`training/pretraining-only, no-E1-signoff` claim boundary. Pins live in
`external/SOURCES.lock.yaml` and per-asset `external/**/manifest.yaml`.

| Corpus | License | Payload | Pinned rev / file | Converted (full local payload) | Allowed use |
| --- | --- | --- | --- | --- | --- |
| TILOS MacroPlacement | BSD-3-Clause | 4.1 GB | `20eddb6b...a2f07` | 16 of 16 direct-DEF cases / 48 records (Ariane133/136, BlackParrot, MemPool, NVDLA) | macro-placement training/eval |
| ChiPBench-D | HF dataset terms | 2.5 GB | HF `MIRA-Lab/ChiPBench-D` | 20 of 20 cases / 60 records | macro-placement pretraining |
| CircuitNet 3.0 | HF dataset terms | ~1 GB | `circuitNetv3.zip` (1,032,704,519 B) | 2004 of 2004 cases / 6012 records (WS4-owned; `--all-records`; 2.53M cell nodes, 4.68M net-fanout edges; smoke uses `--sample-limit`) | timing/power/congestion pretraining; netlist-topology GNN training |
| OpenABC-D | public benchmark | 271 MB | NYU-MLDA/OpenABC | 47 of 47 discovered benches / 141 records | logic-synthesis pretraining (leakage review pending) |
| EDALearn | public | 334 MB | panjingyu/EDALearn | 68 of 68 convertible designs / 204 records | PPA-prediction pretraining |
| AiEDA / iDATA | HF dataset terms | 222 MB | HF `AiEDA/iDATA` | 156 of 156 route-demand maps / 468 records | graph/PPA feature work |
| OpenROAD EDA Corpus | CC-BY-4.0 | 8.9 MB | `473daeb2...d133c` | 2116 instruction records (1691/206/219) | OpenROAD command-assistant / RAG |

Notes:
- Each corpus above is now converted across the **entire locally present
  payload** (`--all-records`), not a small fast-verification sample. Designs that
  lack the required DEF/LEF/netlist files are skipped fail-closed (e.g. EDALearn
  converts the 68 of 85 design dirs that carry the required collateral).
- CircuitNet 3.0 is owned by a separate workstream; only 8 payload files are
  present locally, so its 16-case conversion is bounded by the local payload, and
  the full 2004-case set remains a `--sample-limit` knob, not a code gap.
- No full external dataset is committed. Contamination/overlap audit between
  public training corpora and any E1 evaluation is a standing requirement before
  a model-guided change is accepted.
- Smaller research-code repos (ChipDiffusion, ChiPFormer, CORE, MapTune,
  ABC-RL, abcRL, RL4LS, Macro Placement Challenge, MLCAD FPGA) convert to
  text-instruction/RAG records, not training labels.

## Blocked corpora (payload not present on this host)

The unified training-corpus manifest requires the corpora below, but their
gitignored `external/**/payload/` trees are not fetched on this host, so their
conversions fail closed (zero records) rather than fabricating any. Each is
`allowed_use: training-only` (research-code repos: text/RAG only); none is
released. Fetch payload, then re-run the converter into `--run-id validation`:

| Corpus | Manifest dataset id | Fetch command |
| --- | --- | --- |
| R-Zoo Rectilinear Floorplan | `r_zoo_rectilinear_floorplan` | `python3 scripts/ai_eda/fetch_external_asset.py --asset r-zoo-rectilinear-floorplan --execute` |
| Partcl/HRT Macro Placement Challenge 2026 | `macro_place_challenge_2026` | `python3 scripts/ai_eda/fetch_external_asset.py --asset macro-place-challenge-2026 --execute` |
| MLCAD 2023 FPGA Macro Placement Contest | `mlcad_2023_fpga_macro` | `python3 scripts/ai_eda/fetch_external_asset.py --asset mlcad-2023-fpga-macro --execute` |
| Research-code text/RAG assets (13 repos) | `research_code_assets` | one fetch per repo, e.g. `python3 scripts/ai_eda/fetch_external_asset.py --asset openroad-mcp --execute` (also: orfs-agent, rl4ls, chipdiffusion, chipformer, core-placement, maptune, abc-rl, abcrl, mcp4eda, openroad-agent, open3dbench, dreamplace) |

After fetching, re-run, then rebuild + check:

```
python3 scripts/ai_eda/convert_r_zoo_to_internal_records.py --run-id validation
python3 scripts/ai_eda/convert_macro_place_challenge_2026_to_internal_records.py --run-id validation
python3 scripts/ai_eda/convert_mlcad_2023_fpga_macro_to_internal_records.py --run-id validation
python3 scripts/ai_eda/convert_research_code_assets_to_internal_records.py --run-id validation
python3 scripts/ai_eda/build_training_corpus_manifest.py --run-id validation
python3 scripts/ai_eda/check_training_corpus_manifest.py
```

The R-Zoo `external/SOURCES.lock.yaml` entry records a completed prior fetch
(`verified_by_fetch_report_codex-rzoo-fetch-20260521`); that report's payload is
not present in this checkout, so the gate stays honest and the conversion stays
blocked here until the payload is re-fetched.
