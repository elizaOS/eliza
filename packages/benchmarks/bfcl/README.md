# BFCL — Berkeley Function-Calling Leaderboard

A production-ready, faithful implementation of the [Berkeley Function-Calling
Leaderboard](https://github.com/ShishirPatil/gorilla/tree/main/berkeley-function-call-leaderboard)
benchmark, designed to drop into the elizaOS benchmark harness.

The package vendors the relevant Apache-2.0 BFCL evaluator pieces (multi-turn
runtime + tool implementations) with attribution — see
[`executable_runtime/NOTICE`](executable_runtime/NOTICE).

## Supported categories

| Group | Category | Scoring path | Network |
| --- | --- | --- | --- |
| **Non-live single-turn** | `simple`, `multiple`, `parallel`, `parallel_multiple`, `relevance`, `irrelevance`, `sql`, `java`, `javascript` | AST equality | no |
| **Non-live single-turn — gated** | `rest_api` | AST equality (currently no live REST runner) | yes |
| **Live (user-contributed)** | `live_simple`, `live_multiple`, `live_parallel`, `live_parallel_multiple`, `live_relevance`, `live_irrelevance` | AST equality | no |
| **Multi-turn** | `multi_turn_base`, `multi_turn_miss_func`, `multi_turn_miss_param`, `multi_turn_long_context` | Executable runtime (state equality) | no |
| **Agentic — web_search** | `web_search_base`, `web_search_no_snippet` | Executable runtime | **yes** |
| **Agentic — memory** | `memory_kv`, `memory_vector`, `memory_rec_sum` | (skipped — see below) | no |
| **Non-scoring** | `format_sensitivity` | n/a | n/a |

### Network-gated categories

Categories that require live network / credentials are gated behind the
`--enable-network` CLI flag. Without it, those tests are reported in the
`skipped_no_credentials` bucket and **excluded from the accuracy
denominator** with a logged warning — they are not silently failed.

Currently network-gated:
- `rest_api`
- `web_search_base`, `web_search_no_snippet`

```bash
# Run without network — REST / web_search are skipped
python -m benchmarks.bfcl run --sample 200

# Opt in to network-backed scoring
python -m benchmarks.bfcl run --sample 200 --enable-network
```

### Memory categories

Memory categories (`memory_kv`, `memory_vector`, `memory_rec_sum`) depend on
additional upstream scaffolding (snapshot dirs, prereq conversation files,
`bfcl_eval.utils` helpers) that we do not vendor. They are reported in the
`skipped_unsupported` bucket. To enable, install `bfcl-eval` from upstream
and the runtime will fall through to the upstream helpers.

## Evaluation

### Single-turn

AST equality between the predicted and ground-truth call list, using the
faithful BFCL AST checker logic. The AST checker preserves a small set of
intentional quirk-tolerance fixes (annotated in
[`evaluators/ast_evaluator.py`](evaluators/ast_evaluator.py)) — these are
documented overrides of upstream behaviour that the upstream issue tracker
also reports as undesirable.

### Multi-turn

Per-turn agent loop:
1. Feed the current user turn (plus any prior assistant + tool result
   messages) into the agent.
2. Decode the upstream-canonical python-list-of-calls from the agent's
   response (`decode_python_calls`).
3. Execute the calls against a per-test
   [`ExecutableRuntime`](executable_runtime/runtime.py) that holds the
   vendored upstream tool instances (GorillaFileSystem, MathAPI,
   TwitterAPI, ...).
4. Repeat for the next turn (state persists across turns).
5. At the end, also execute the ground-truth trajectory against a fresh
   runtime and compare final per-class instance state.

### Executable evaluator

The previous evaluator used **synthetic always-success mock handlers** —
`exec_accuracy` was always 1.0 regardless of the model's calls. That
behaviour is removed. The new evaluator actually invokes the upstream tool
implementations and compares output state. Unregistered functions return
failure, NOT auto-success.

## CLI

```bash
# List available models / providers
python -m benchmarks.bfcl models

# Sample run (50 stratified tests)
python -m benchmarks.bfcl run --sample 50

# Run a specific category set
python -m benchmarks.bfcl run --categories simple,multiple,multi_turn_base

# Full benchmark, with network-gated categories enabled
python -m benchmarks.bfcl run --full --enable-network

# Local data path (avoids HuggingFace)
python -m benchmarks.bfcl run --local-data ./data/bfcl

# Run all + show baselines
python -m benchmarks.bfcl info --baselines
```

## Reporting

The run summary now distinguishes:

- `total_tests` — number of tests that contributed to accuracy.
- `passed_tests` / `failed_tests` — among `total_tests`.
- `skipped_tests` — excluded from accuracy.
- `skipped_by_reason` — bucketed by status:
  - `skipped_no_credentials`
  - `skipped_no_ground_truth`
  - `skipped_unsupported`

## License

Vendored upstream sources are Apache License 2.0 (Berkeley/Gorilla). See
[`executable_runtime/NOTICE`](executable_runtime/NOTICE) for attribution.
