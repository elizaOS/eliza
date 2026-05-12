# Cerebras backoff + lower default concurrency (W4-C)

W2-9 observed 3/25 hermes scenarios erroring with Cerebras HTTP 429
(rate-limit) at `ELIZA_BENCH_CONCURRENCY=4`. This pass adds exponential
backoff with `Retry-After` honored to all three Cerebras-facing adapter
clients and lowers the default concurrency to 2.

## Retry policy spec

All three adapter clients now share the same retry semantics (each adapter
ships its own copy of the helper module to preserve package isolation —
`hermes_adapter._retry`, `openclaw_adapter._retry`, and inline helpers in
`eliza_lifeops_bench.clients.cerebras`):

- **Trigger:** HTTP 429, any HTTP 5xx, or network/connection errors
  (`APIConnectionError` / `APITimeoutError` / `URLError` /
  `httpx.NetworkError` / `httpx.TimeoutException` /
  `httpx.RemoteProtocolError` / `OSError`).
- **Max attempts:** 5 (1 initial + 4 retries).
- **Backoff schedule:** exponential — `1s, 2s, 4s, 8s, 16s`.
- **`Retry-After` honored:** if the server includes a `Retry-After` header
  (either delta-seconds or HTTP-date), it overrides the default backoff for
  that attempt. Values are clamped to `≤ 60s` to avoid pathological waits.
  Negative deltas clamp to `0s`.
- **Non-retryable 4xx surfaces immediately** (400/401/403/404 etc.). Retrying
  them only delays the real failure.
- **Exhaustion:** raises a structured `RetryExhaustedError` (hermes /
  openclaw) or `ProviderError` (cerebras client) containing the attempt
  count and last status / error string so the runner logs it cleanly.

## Files changed

### Retry helpers (new)

- `packages/benchmarks/hermes-adapter/hermes_adapter/_retry.py`
- `packages/benchmarks/openclaw-adapter/openclaw_adapter/_retry.py`

### Adapter client wiring

- `packages/benchmarks/hermes-adapter/hermes_adapter/client.py`
  - `_send_in_process`: wrapped `oai.chat.completions.create()` in the
    5-attempt retry loop; constructs the `OpenAI` client with
    `max_retries=0` so the SDK's built-in retries do not double-up with
    ours. `Retry-After` is pulled from the `RateLimitError.response.headers`
    shape exposed by the openai SDK.
  - `_SEND_MESSAGE_SCRIPT` (the embedded venv-spawned script for
    `subprocess` mode): inline retry loop with the same policy, since the
    script can't import our helper module. Logs each retry to stderr so the
    parent's `[hermes-adapter retry attempt …]` lines remain visible in
    captured `stderr`.
- `packages/benchmarks/openclaw-adapter/openclaw_adapter/client.py`
  - Extracted the body POST into `_post_with_retry()` at module scope.
    Handles `urllib.error.HTTPError` (with status) vs `URLError` (network)
    distinctly.
- `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/clients/cerebras.py`
  - Replaced the single fixed-2s retry on 429/5xx with a 5-attempt
    exponential-backoff loop via the new `_post_with_retry` method.
  - 4xx other than 429 still surfaces as `ProviderError` immediately
    (preserves existing wire-error contract for callers).

### Default concurrency

- `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/__main__.py`
  - `--concurrency` default: **4 → 2**.
- `scripts/lifeops-full-run.mjs`
  - `ELIZA_BENCH_CONCURRENCY` default: **4 → 2**.
  - Documented the rationale at the env-var declaration and at the
    `envInt(...)` call site.

These two defaults are independent — the env var dominates when running via
`lifeops:full`, the argparse default dominates when invoking the Python
module directly. Both are now `2` so behavior is consistent across entry
points.

## Test coverage

### New test files

- `packages/benchmarks/hermes-adapter/tests/test_retry.py` — **16 tests**
  - `parse_retry_after` — None / seconds / clamping / HTTP-date / unparseable
  - `backoff_seconds` schedule and clamping
  - `is_retryable_status` — 429, 5xx, 4xx, 2xx
  - `RetryExhaustedError` state recording
  - In-process retry: 429×2 → 200 (3 attempts, correct sleep schedule)
  - In-process retry: honors `Retry-After: 5` (next sleep is 5s, not 1s)
  - In-process retry: exhausts after 5 × 429 → raises `RetryExhaustedError`
  - In-process retry: does NOT retry a 400 (surfaces immediately)
  - In-process retry: retries on 500
  - In-process retry: retries on `APIConnectionError`

- `packages/benchmarks/openclaw-adapter/tests/test_retry.py` — **12 tests**
  - Same shape as hermes: helper-fn tests + HTTP retry-loop tests
    using `urllib.request.urlopen` monkeypatched to a fake.

### Updated tests

- `packages/benchmarks/lifeops-bench/tests/test_clients.py`
  - `test_cerebras_retries_once_on_429` kept (verifies 429 → 200 still
    succeeds with 2 wire calls; legacy single-retry name preserved).
  - `test_cerebras_raises_provider_error_after_second_5xx` **replaced**
    by `test_cerebras_exhausts_after_max_attempts_on_5xx` — verifies
    the new policy retries up to 5 times on 5xx.
  - Added `test_cerebras_retries_429_twice_then_succeeds`,
    `test_cerebras_does_not_retry_400`,
    `test_cerebras_honors_retry_after_header`.

### Test pass counts

| Suite | Pass | Skip | Fail | Notes |
| --- | --- | --- | --- | --- |
| `hermes-adapter/tests/test_retry.py` | 16 | 0 | 0 | new |
| `openclaw-adapter/tests/test_retry.py` | 12 | 0 | 0 | new |
| `lifeops-bench/tests/test_clients.py` | 19 | 1 | 0 | + 4 new cases |
| `hermes-adapter` full | 59 | 0 | 0 | excluding pre-existing `test_lifeops_bench_factory` failure unrelated to retry (W4 type-rename) |
| `openclaw-adapter` full | 60 | 2 | 5 | pre-existing failures unrelated to retry (missing local OpenClaw checkouts) |
| `lifeops-bench` adapter/client tests | 51 | 4 | 0 | clients + agents |

## Concurrency change

| Setting | Before | After |
| --- | --- | --- |
| `lifeops-bench --concurrency` default | 4 | **2** |
| `ELIZA_BENCH_CONCURRENCY` env default in `scripts/lifeops-full-run.mjs` | 4 | **2** |

Operators running non-Cerebras providers (Anthropic, OpenAI, local
llama.cpp) can still raise the value back to 4+ via `--concurrency` or the
env var.
