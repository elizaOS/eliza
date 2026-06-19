# SWE-bench Multilingual — Integration Notes

This directory is a stripped clone of [SWE-bench/SWE-bench](https://github.com/SWE-bench/SWE-bench)
(the canonical SWE-bench harness, which now includes first-class multilingual
support via per-language modules in `swebench/harness/constants/`,
`swebench/harness/dockerfiles/`, and `swebench/harness/log_parsers/`).

The dataset itself is hosted on Hugging Face as
**`SWE-bench/SWE-bench_Multilingual`** (single `test` split, 300 instances).

No `.git`, CI, or large media has been included. We kept the harness, README,
LICENSE, CHANGELOG, docs, and tests so the wiring layer in the adapters can be
written against verifiable upstream code paths.

---

## 1. Coverage

### Languages and task counts (300 total instances)

| Language       | Tasks |
|----------------|-------|
| Ruby           | 44    |
| Go             | 42    |
| Java           | 43    |
| JavaScript/TS  | 43    |
| PHP            | 43    |
| Rust           | 43    |
| C              | 30    |
| C++            | 12    |

Source: [swebench.com/multilingual-leaderboard.html](https://www.swebench.com/multilingual-leaderboard.html).

Per-language harness modules (in this clone):

```
swebench/harness/constants/{c,go,java,javascript,php,python,ruby,rust}.py
swebench/harness/dockerfiles/{c,go,java,javascript,php,python,ruby,rust}.py
swebench/harness/log_parsers/{c,go,java,javascript,php,python,ruby,rust}.py
```

`python.py` is present because the same harness also runs the original Python
SWE-bench / SWE-bench_Lite / SWE-bench_Verified datasets — multilingual is
selected purely by `--dataset_name`.

### Task instance shape

Same `SWEbenchInstance` TypedDict as classic SWE-bench
(`swebench/harness/constants/__init__.py`):

```python
class SWEbenchInstance(TypedDict):
    repo: str
    instance_id: str
    base_commit: str
    patch: str               # gold patch (not given to the agent)
    test_patch: str
    problem_statement: str
    hints_text: str
    created_at: str
    version: str
    FAIL_TO_PASS: str        # JSON-encoded list of test ids
    PASS_TO_PASS: str        # JSON-encoded list of test ids
    environment_setup_commit: str
```

The multilingual split adds no new schema fields. The language is inferred
from `repo` and routed through the per-language constants / dockerfile /
log-parser modules at evaluation time.

---

## 2. Runner Interface

The canonical entrypoint is `swebench.harness.run_evaluation` (the same one
the classic Python benchmark uses):

```bash
python -m swebench.harness.run_evaluation \
  --dataset_name SWE-bench/SWE-bench_Multilingual \
  --split test \
  --predictions_path <path-to-predictions.json> \
  --max_workers 4 \
  --run_id <run-tag>
```

Key flags (see `swebench/harness/run_evaluation.py::main`):

- `--dataset_name` — HF id or local JSON. For multilingual:
  `SWE-bench/SWE-bench_Multilingual`.
- `--split` — `test` (multilingual has only `test`).
- `--instance_ids` — optional subset to run.
- `--predictions_path` — JSON / JSONL with `{instance_id, model_name_or_path, model_patch}`
  per record. The string `"gold"` runs the gold patches as a sanity check.
- `--max_workers`, `--timeout`, `--cache_level`, `--force_rebuild`,
  `--namespace`, `--instance_image_tag`, `--report_dir`.
- `--modal true` switches to Modal cloud execution; default is local Docker.

Predictions file shape (one entry per instance):

```json
{
  "instance_id": "facebook__react-12345",
  "model_name_or_path": "eliza-adapter",
  "model_patch": "diff --git a/... ...\n"
}
```

The agent produces `model_patch` (a unified diff against `base_commit`); the
harness applies it inside a per-instance Docker container and runs the repo's
test command.

---

## 3. Scoring

Implemented in `swebench/harness/grading.py` and aggregated by
`swebench/harness/reporting.py`. For each instance the harness records:

- `resolved` (bool) — true iff every `FAIL_TO_PASS` test now passes **and**
  every `PASS_TO_PASS` test still passes.
- `tests_status` — per-test buckets (`PASSED`, `FAILED`, `ERROR`, `TIMED_OUT`).
- `patch_successfully_applied`, `patch_exists`.

The aggregate report (written under `logs/run_evaluation/<run_id>/` and as a
JSON summary in the working directory) reports `resolved_instances`,
`unresolved_instances`, `error_instances`, etc. The leaderboard metric is
**% resolved over 300**.

---

## 4. Docker Requirements

From upstream README and verified in `swebench/harness/docker_build.py`:

- Docker daemon running (local mode).
- Recommended host: x86_64, 120 GB free disk, 16 GB RAM, 8+ CPU cores.
- Per-language base images pulled from Docker Hub
  (`swebench/sweb.base.<lang>.<arch>:latest`) — built / referenced from
  `swebench/harness/dockerfiles/<lang>.py`.
- ARM (Apple Silicon) requires `--namespace ''` to force local builds; some
  per-language base images may not yet exist for `linux/arm64` — verify per
  language before claiming coverage.
- Three layers of caching, controllable via `--cache_level`:
  `none` < `base` < `env` < `instance` (default `env`).
- Disk: a full multilingual run can produce 50–100 GB of intermediate images
  unless `--cache_level base` is used.

For Modal cloud execution (`--modal true`), `swebench/harness/modal_eval/`
encapsulates the same harness but skips local Docker; this is the fastest
path for evaluation without a beefy local host.

---

## 5. Wiring into the eliza / hermes / openclaw adapters

We **do not** implement the adapter in this pass. The integration mirrors the
existing pattern in
`/Users/shawwalters/eliza-workspace/milady/eliza/packages/benchmarks/eliza-adapter/eliza_adapter/swe_bench.py`,
which provides a `TEXT_LARGE` handler that the SWE-bench agent loop invokes
per turn and routes through `ElizaClient`.

To wire multilingual:

### A. Dataset loader (shared)

`packages/benchmarks/swe_bench/dataset.py` currently maps three variants
(`FULL`, `LITE`, `VERIFIED`) via `DATASET_MAPPING`. Add a fourth:

```python
class SWEBenchVariant(Enum):
    FULL = "full"
    LITE = "lite"
    VERIFIED = "verified"
    MULTILINGUAL = "multilingual"          # new

DATASET_MAPPING = {
    ...
    SWEBenchVariant.MULTILINGUAL: "SWE-bench/SWE-bench_Multilingual",
}
```

No other dataset-side changes are needed — `SWEbenchInstance` is
schema-compatible.

### B. Per-adapter wiring

Each of `eliza-adapter`, `hermes-adapter`, and `openclaw-adapter` already has
a `swe_bench.py` (eliza) or equivalent that produces a `TEXT_LARGE` model
handler for the agent loop. The multilingual harness is **identical** at the
model-call layer — it still feeds the agent a problem statement and expects a
unified diff — so the handler signature is unchanged.

What each adapter needs to add:

1. **Variant routing.** Accept a `variant` / CLI flag (`--variant multilingual`)
   and pass it through to the shared `SWEBenchDataset` loader.
2. **Per-language prompts (optional).** If the adapter ships custom
   system / character prompts, gate them on the instance's language so the
   agent knows it's editing Go / Rust / etc. The language is derivable from
   `repo` (see `swebench/harness/test_spec/`) — the harness keeps a registry
   that maps repos to languages; expose this in the adapter as a small
   `repo_to_language(instance.repo) -> Language` helper.
3. **Run-script entrypoint.** Match the existing pattern in
   `eliza-adapter/eliza_adapter/swe_bench.py`. Spawn the harness via
   `python -m swebench.harness.run_evaluation --dataset_name SWE-bench/SWE-bench_Multilingual ...`
   and consume the `logs/run_evaluation/<run_id>/` output the same way as the
   Lite / Verified flows.
4. **Docker prerequisites.** Document the larger disk requirement (50–100 GB)
   in each adapter's README. Multilingual will silently fail in CI unless the
   runner has Docker + enough scratch space.
5. **Test-status parser.** Use `swebench.harness.log_parsers.<lang>` — the
   harness picks the right parser by language; no adapter-side changes are
   needed unless the adapter wraps log inspection itself.

### C. Verification path

After wiring, sanity-check with:

```bash
python -m swebench.harness.run_evaluation \
  --dataset_name SWE-bench/SWE-bench_Multilingual \
  --predictions_path gold \
  --instance_ids <one id per language> \
  --run_id ml-smoke
```

`predictions_path=gold` runs the upstream gold patches — every instance must
resolve. Anything less means the local Docker environment is broken, not the
adapter.

---

## 6. Source

Cloned from `https://github.com/SWE-bench/SWE-bench` (default branch, depth
1) on 2026-05-12. The dataset reference is the upstream-recommended HF id
`SWE-bench/SWE-bench_Multilingual` (the older `princeton-nlp/*` namespace
still resolves but is not the canonical one for the multilingual split).
