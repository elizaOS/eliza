# Dataset cards — converted AI-EDA corpora (2026-05-21, Linux host)

All payloads live under ignored `external/**/payload/`; only metadata,
manifests, hashes, and converted internal records are tracked. Every converted
record carries source hashes, schema version, split id, and a
`training/pretraining-only, no-E1-signoff` claim boundary. Pins live in
`external/SOURCES.lock.yaml` and per-asset `external/**/manifest.yaml`.

| Corpus | License | Payload | Pinned rev / file | Converted (this run) | Allowed use |
| --- | --- | --- | --- | --- | --- |
| TILOS MacroPlacement | BSD-3-Clause | 4.1 GB | `20eddb6b...a2f07` | 16 cases / 48 records (Ariane133/136, BlackParrot, MemPool, NVDLA; 2339 placed-macro labels) | macro-placement training/eval |
| ChiPBench-D | HF dataset terms | 2.5 GB | HF `MIRA-Lab/ChiPBench-D` | 4 of 20 cases / 12 records (361 macro targets) | macro-placement pretraining |
| CircuitNet 3.0 | HF dataset terms | ~1 GB | `circuitNetv3.zip` (1,032,704,519 B) | 16 of 2004 cases / 48 records | timing/power/congestion pretraining |
| OpenABC-D | public benchmark | 271 MB | NYU-MLDA/OpenABC | 2 benches / 6 records | logic-synthesis pretraining (leakage review pending) |
| EDALearn | public | 334 MB | panjingyu/EDALearn | 8 designs / 24 records | PPA-prediction pretraining |
| AiEDA / iDATA | HF dataset terms | 222 MB | HF `AiEDA/iDATA` | 3 route-demand maps / 9 records | graph/PPA feature work |
| OpenROAD EDA Corpus | CC-BY-4.0 | 8.9 MB | `473daeb2...d133c` | 2116 instruction records (1691/206/219) | OpenROAD command-assistant / RAG |

Notes:
- Conversions are **bounded local samples** for fast verification, not the full
  corpora. Case counts are a knob carried into the CUDA run plan for scale-out.
- No full external dataset is committed. Contamination/overlap audit between
  public training corpora and any E1 evaluation is a standing requirement before
  a model-guided change is accepted.
- Smaller research-code repos (ChipDiffusion, ChiPFormer, CORE, MapTune,
  ABC-RL, abcRL, RL4LS, Macro Placement Challenge, MLCAD FPGA) convert to
  text-instruction/RAG records, not training labels.
