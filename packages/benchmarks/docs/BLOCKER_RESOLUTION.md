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

`node --import tsx packages/lifeops-bench/src/server.ts` (managed by
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

## Cosmetic-harness benchmarks (configbench, interrupt-bench)

Investigated and reclassified: these route every harness through the **eliza
runtime** (`configbench/scripts/harness_bridge_turn.py` uses `ElizaClient` for
all non-eliza labels). The "harness" label is cosmetic — they measure elizaOS
config/secret/interrupt subsystems, not a swappable model harness. A faithful
`SmithersClient` run of configbench scores 0.0 because a bare model harness has
no elizaOS config plugins, confirming there is **no real smithers analog** (same
category as the eliza-native set). The existing hermes/openclaw 1.0s are
ElizaClient runs. Not force-posted for smithers to avoid a misleading row.

## Genuinely external (need real secrets / assets / ML runtimes)

- **Chain**: `evm` (`RPC_URL` + funded `AGENT_PRIVATE_KEY`), `solana`,
  `hyperliquid_bench` (`HL_PRIVATE_KEY` + live markets) — real funds/keys.
- **Audio**: `voicebench`×3, `voiceagentbench` — `faster_whisper` (heavy
  ctranslate2/tokenizers deps, can't wheel-extract into the pip-broken venv) +
  real audio assets.
- **Multimodal**: `vision_language`, `visualwebbench` — a local VLM runtime
  (eliza-1 VLM) or a multimodal API model.

These have no in-sandbox code blocker; they require resources outside it.

## Net result

The systemic, in-sandbox blockers (Docker daemon, venv deps, the TS bridge, the
Node version) are all resolved and proven. Smithers posts on **18** benchmarks
(every model-harness-applicable benchmark that doesn't need external
secrets/assets). The remainder is split between eliza-runtime/cosmetic-harness
benchmarks (no smithers analog) and externally-gated infra. Per-harness smithers
factories are tracked in CERTIFICATION.md / RESULTS_MATRIX.md.
