# Benchmark blocker resolution (2026-05-29)

The benchmarks that were previously "unrunnable in this sandbox" were blocked by
**three systemic infrastructure gaps**, not by missing benchmark code. All three
are now resolved and proven end-to-end.

## 1. Docker daemon — RESOLVED (running)

The `_has_swe_bench_docker_backend` / `_has_terminal_bench_docker_backend` /
`_has_osworld_docker_backend` gates only check `_docker_info_available()`. With
the daemon up, fresh `discover_adapters()` now returns
`('eliza','openclaw','hermes')` (was `()`) for: **swe_bench, terminal_bench,
osworld, gauntlet, webshop, loca_bench, visualwebbench, mmau**.

Proven end-to-end: `terminal_bench --agent hermes` (task `hello-world`) →
`status=succeeded` through the real Docker-backed task harness.

## 2. `.venv-standard` missing Python deps — RESOLVED (and a repeatable method)

The shared `.venv-standard` (Python 3.12) was missing packages and has **no
working pip** (`ensurepip` and the sibling `context-bench/.venv` pip both fail on
a pre-existing homebrew-python/expat issue). Fix: install pure-Python wheels by
downloading from PyPI and extracting into site-packages.

Resolved gaps this pass:
- `openai` (+ `distro`, `jiter`, `tqdm`) — copied from `context-bench/.venv`.
  Unblocks the **mt_bench judge** (smithers mt_bench now posts 0.80).
- `aiofiles` — PyPI wheel extracted. Unblocks **terminal_bench** dataset import.

Repeatable method for any further gap:
```bash
DST=.venv-standard/lib/python3.12/site-packages
curl -sL "$(curl -s https://pypi.org/pypi/<pkg>/json \
  | python3 -c 'import sys,json;print([u["url"] for u in json.load(sys.stdin)["urls"] if u["url"].endswith(".whl")][0])')" -o /tmp/p.whl
( cd "$DST" && unzip -o /tmp/p.whl )
```

## 3. elizaOS TS bench bridge — RESOLVED (boots)

`node --import tsx packages/app-core/src/benchmark/server.ts` (managed by
`ElizaServerManager`) boots with Node `v22.22.3` + `tsx`. Bridge-routed
benchmarks now post for smithers: **mind2web 1.00** (this pass), with
mint/realm/lifeops_bench already posted by the parallel factory work.

## Node upgrade (openclaw latest)

openclaw `2026.5.27` requires Node ≥ 22.19; installed `v22.22.3` via nvm and set
as default. openclaw runs (`OpenClaw 2026.5.27`).

## What remains genuinely external

- **Chain credentials**: `hyperliquid_bench` (HL_PRIVATE_KEY), `solana`/`evm`
  (RPC + funded keys), `gauntlet` (the `surfpool` binary for the mainnet-backed
  path). No code blocker — these need real secrets/binaries.
- **Real audio assets / multimodal runtime**: `voicebench`×3, `voiceagentbench`,
  `vision_language` gate on local audio + a VLM runtime.
- **eliza-native, eliza-only by design**: experience, trust, adhdbench,
  personality_bench, social_alpha, eliza_1, eliza_replay measure elizaOS runtime
  subsystems and have no model-harness swap; they post on `eliza` only.

Everything else is now runnable; per-harness smithers factories are tracked in
CERTIFICATION.md / RESULTS_MATRIX.md.
