# CI Demo Playbook

This document explains how to exercise HyperLiquidBench in **demo mode** inside
CI/CD without touching live Hyperliquid endpoints. The flow produces the same
artifacts (`per_action.jsonl`, `eval_score.json`, etc.) the frontend and
scoring pipeline expect, but all order acknowledgements and websocket events are
synthetic.

> **Why demo mode?**
>
> - Runs deterministically without network latency or API keys.
> - Safe to share publicly—`run_meta.json` contains `"demoMode": true` and
>   websocket frames carry `"demo": true`.
> - Enables end-to-end regression tests for the evaluator and frontend data
>   without funding testnet wallets.

---

## 1. Checkout and install toolchain

```bash
rustup toolchain install stable
rustup default stable

# optional: cache dependencies
cargo fetch
```

If you are using GitHub Actions or another container-based runner, make sure the
image includes OpenSSL/clang (`brew install openssl` on macOS runners, or
`apt-get install -y libssl-dev pkg-config` on Debian/Ubuntu).

---

## 2. Run the demo workflow

Example commands executed from the repository root:

```bash
# 2.1 Execute a canned plan (no keys required)
cargo run -p hl-runner --release -- \
  --demo \
  --plan dataset/tasks/hl_perp_basic_01.jsonl:1 \
  --out runs/demo

# 2.2 Evaluate coverage for the synthetic run
cargo run -p hl-evaluator --release -- \
  --input runs/demo/per_action.jsonl \
  --domains dataset/domains-hl.yaml \
  --out-dir runs/demo
```

Artifacts produced under `runs/demo/`:

- `per_action.jsonl` – synthetic action log.
- `ws_stream.jsonl` – mocked websocket frames with `"demo": true`.
- `orders_routed.csv` – deterministic order ledger.
- `run_meta.json` – contains `"demoMode": true` and the CLI version.
- `eval_per_action.jsonl`, `eval_score.json`, `unique_signatures.json` – evaluator outputs.

To exercise the wrapper script instead of raw commands:

```bash
OUT_DIR=runs/demo scripts/run_cov.sh dataset/tasks/hl_perp_basic_01.jsonl:1 -- --demo
```

---

## 3. Validate and surface results

Recommended CI assertions:

1. **Cargo hygiene**
   ```bash
   make check   # clippy --deny warnings
   make test    # includes demo-mode unit tests
   ```
2. **Evaluate score sanity**
   ```bash
   jq '.finalScore' runs/demo/eval_score.json
   jq '.perDomain[] | {name, uniqueCount}' runs/demo/eval_score.json
   ```
   Use these to ensure the score file exists and contains expected fields.
3. **Collect artifacts**
   Upload the entire `runs/demo/` directory as a build artifact so the frontend
   preview (or downstream tooling) can ingest the sample run.

---

## 4. Extending the demo scenario

- Swap `dataset/tasks/hl_perp_basic_01.jsonl:1` with any other task in
  `dataset/tasks/*.jsonl` to cover different surfaces.
- For broader coverage, loop over multiple tasks inside the CI job.
- To exercise the LLM generator without real execution, combine `--demo` with
  `HL_LLM_DRYRUN=1` and the appropriate `LLM_MODEL`/`OPENROUTER_API_KEY`
  variables (see README for details).

Example snippet for multiple tasks:

```bash
for task in dataset/tasks/*.jsonl; do
  name=$(basename "$task" .jsonl)
  out_dir="runs/demo-$name"
  cargo run -p hl-runner --release -- --demo --plan "$task":1 --out "$out_dir"
  cargo run -p hl-evaluator --release -- --input "$out_dir/per_action.jsonl" \
    --domains dataset/domains-hl.yaml --out-dir "$out_dir"
  jq '.finalScore' "$out_dir/eval_score.json"
done
```

---

## 5. Clean-up

Demo runs do not modify any on-chain state, but they do leave artifacts on disk.
If your CI workspace is short-lived this is optional; otherwise, delete the
`runs/` directory after uploading artifacts.

```bash
rm -rf runs/
```

---

## 6. Summary checklist

- [ ] Install Rust toolchain & dependencies
- [ ] Execute runner with `--demo`
- [ ] Evaluate coverage output
- [ ] Run clippy/tests
- [ ] Upload `runs/demo/` artifacts
- [ ] (Optional) Clean workspace

With these steps in your pipeline, HyperLiquidBench can demonstrate the
end-to-end coverage story without managing real keys or wallets.
