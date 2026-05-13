# Eliza-1 Vast 3090 Release Plan

Date: 2026-05-12

## Critical Assessment

The existing Vast stack now has usable foundations: model-specific Vast endpoint routing, per-model failover, manifest-driven vLLM endpoint provisioning, a llama.cpp PyWorker path, token pricing defaults, and an Eliza-1 eval collector. The gaps are operational, not just modeling:

- The 27B production manifest targets 2x H200-class vLLM at 131K, not the running 1x RTX 3090.
- The club-3090 262K technique is llama.cpp/GGUF with one slot and q4_0 KV cache. It is not the current H200 vLLM/TurboQuant path.
- DFlash is not the proven 1x3090/262K unlock. It remains optional and must be benchmark-gated on the custom llama.cpp build before enabling on this profile.
- Final Eliza-1 2B/9B/27B bundle evidence is incomplete in current readiness docs, so release gates must fail when artifacts are missing.
- Billing and analytics lack enough durable join keys for full Vast cost reconciliation against actual provider spend.
- Dashboard alerts exist mostly as UI surfaces; policy evaluation and persisted alert events need server-side gates.

## Gap Matrix

| Area | Current State | Gap | Required Fix |
| --- | --- | --- | --- |
| 3090 serving | H200/vLLM manifests existed; 3090 path was implicit | 1x RTX 3090 262K requires llama.cpp, q4_0 KV, one slot | Separate 3090 llama manifest, doctor checks, catalog alias, pricing, and fallback |
| Runtime flags | `onstart.sh` accepted generic extra args | Long-context Qwen/Eliza flags were easy to omit or duplicate | First-class `LLAMA_CONTEXT`, `LLAMA_PARALLEL`, q4 KV, flash-attn, Jinja, reasoning-disable envs |
| DFlash | Custom build surface exists | Not proven for 262K retained-context 3090 serving | Keep off by default; benchmark against q4_0 baseline before enabling |
| Queueing/batching | vLLM lane has batching assumptions | llama.cpp 3090 lane can only safely use one retained-context slot | Explicit `--parallel 1`; scale out by more instances, not more slots |
| Caching | q4 KV cache is configured | No durable prompt/result cache tied to billing/request IDs | Add per-request cache keys with provider/model/template/quant/context and usage join IDs |
| Autoscaling up | Vast provisioning scripts exist | No policy tying queue depth, TTFT, and GPU health to 3090 replicas | Add autoscaler decision loop with min/max replicas, cool-down, and cost cap |
| Autoscaling down | Endpoint deletion/update scripts exist | No drain-aware scale-down gate for llama-server | Add readiness drain, in-flight count, idle age, and cost reconciliation before destroy |
| Analytics | Usage events exist in pieces | Provider/model cost rendering and Vast spend reconciliation were incomplete | Persist provider request ID, instance ID, price snapshot, token counts, ledger ID, and Vast invoice/spend row |
| Failover | Provider fallback exists | No live kill evidence for Vast serving nodes | Kill test must show readiness flip, no new traffic on killed node, and fallback traffic success |
| Dashboards | Dashboard surfaces exist | Alerts were not release-enforced | Persist alert evaluations and test red/yellow dashboard render states |
| Evals | Eliza-1 eval collector exists | Final 2B/9B/27B evidence is incomplete | Gate release on tier smoke, quality, performance, and artifact freshness |

## 3090 Deployment Lane

Use a separate profile for single-card long context:

- Runtime: `llama.cpp` / `llama-server`.
- Model: GGUF from `elizaos/eliza-1`, `bundles/27b-256k/text/eliza-1-27b-256k.gguf`.
- Context: `262144`.
- Parallel slots: `1`.
- GPU layers: `99`.
- KV cache: `--cache-type-k q4_0 --cache-type-v q4_0`.
- Attention/template: `-fa on --jinja --reasoning-format none`.
- Thinking: `--chat-template-kwargs {"enable_thinking":false}`.
- Vast search: 1x RTX 3090, 24 GiB VRAM, 80 GiB disk, verified host.

Manifest: `cloud/services/vast-pyworker/manifests/eliza-1-27b-256k-3090.json`.

## Swarm Waves

Wave 0, discovery:

- Vast lead: inventory running instances, SSH, port forwards, image/toolchain, disk, GPU, and cost/hour.
- Runtime lead: diff club-3090 against local llama.cpp/DFlash/TurboQuant/QJL/Polar assumptions.
- Gate lead: map every release gate to current harnesses and missing evidence.

Wave 1, deployment substrate:

- Add the 3090 llama manifest and doctor checks.
- Add first-class llama flags to `onstart.sh` instead of fragile `LLAMA_EXTRA_ARGS`.
- Add catalog model `vast/eliza-1-27b-256k`, endpoint suffixes, pricing defaults, and fallback to `vast/eliza-1-27b`.
- Build or install the custom CUDA llama.cpp binary on the live 3090.

Wave 2, live staging:

- Download the final Eliza-1 GGUF bundle, or use a clearly marked Qwen/Unsloth stand-in only for infrastructure smoke.
- Start llama-server on local port 8080 so Vast forwards it externally.
- Capture `/v1/models`, non-stream chat, streaming chat, tool-call JSON, GPU memory, latency, and token usage.
- Write evidence under `reports/eliza1-release-gates/`.

Wave 3, release gates:

- 2B/9B/27B smoke: load/generate/tool-call/usage evidence per tier.
- Streaming parity: unit test and live endpoint stream/non-stream parity evidence.
- Cold-start/burst: process-to-ready, first-token latency, p95, timeout/error budget.
- Soak: 1 hour, crash-free, RSS/VRAM leak budget, no growing queue.
- Failover kill: kill one serving node, readiness flips, in-flight drains, new traffic moves.
- Billing: usage record, credit transaction, idempotency key, invoice/billing row.
- Cost reconciliation: usage revenue, ledger delta, actual Vast spend, drift threshold.
- Alerts: persisted alert events and dashboard red/yellow render states.
- Quality/perf evals: `eliza1:gates` for required tiers with no `needs-data` release blockers.

Wave 4, optimization:

- Compare stock q4_0 KV, custom build q4_0 KV, DFlash-enabled custom build, and any QJL/Polar/TurboQuant KV variants that the binary supports.
- Optimize only against measured gates: TTFT, decode TPS, retained-context latency, VRAM, tool-call exactness, quality eval deltas, and cost/request.
- Do not enable DFlash on the 3090 262K lane until it beats the q4_0 baseline without context regressions.

## Sub-Agent Task Cards

| Agent | Ownership | Done Criteria |
| --- | --- | --- |
| Vast staging lead | `cloud/scripts/vast`, live Vast instance, PyWorker manifest | 3090 instance inventoried, template dry-run passes, live endpoint serves `/v1/models` and chat |
| Runtime build lead | `packages/app-core/scripts/build-llama-cpp-dflash.mjs`, remote llama.cpp build | Custom CUDA llama-server builds on sm_86; q4_0 KV path is runnable; all-quant build result recorded separately |
| Model artifact lead | Eliza-1 2B/9B/27B bundle paths and GGUF availability | Final artifacts are downloaded or blockers are explicit; stand-ins are clearly labeled as non-release |
| Streaming parity lead | `plugins/plugin-openai`, live staging harness | Unit parity and live stream/non-stream tool-call evidence both pass |
| Load/soak lead | `scripts/eliza1-vast-staging-harness.mjs`, remote server logs | Cold-start, burst, and 1-hour soak artifacts are fresh and pass thresholds |
| Failover lead | provider fallback config and live kill test | Kill test captures killed node, readiness flip, fallback success, and recovery notes |
| Cost/billing lead | pricing catalog, usage rows, ledger/credit records | Usage, billing, and Vast spend reconcile within drift threshold with durable IDs |
| Dashboard lead | analytics dashboard and alert policies | Alert events are persisted and dashboard red/yellow states render from real data |
| Eval lead | `packages/training/benchmarks`, `packages/inference/verify` | 2B/9B/27B quality/perf reports pass and are linked in release evidence |

## Validation Commands

Local checks:

```bash
bun run --cwd cloud vast:doctor
VASTAI_API_KEY=test VAST_TEMPLATE_ID=123 ELIZA_VAST_MANIFEST=eliza-1-27b-256k-3090.json VAST_DRY_RUN=1 bun --cwd cloud scripts/vast/provision-endpoint.ts
bun test --preload ./cloud/packages/tests/load-env.ts cloud/packages/tests/unit/vast-pricing.test.ts cloud/packages/tests/unit/providers-vast.test.ts cloud/packages/tests/unit/providers-fallback.test.ts cloud/packages/tests/unit/vast-provisioning.test.ts cloud/packages/tests/unit/model-catalog.test.ts
bun run --cwd plugins/plugin-openai test -- native-plumbing.shape.test.ts
bun run eliza1:release-gates
```

Live staging checks:

```bash
bun run eliza1:vast-staging -- --base-url http://ssh3.vast.ai:<forwarded-port> --model vast/eliza-1-27b-256k --instance-id <vast-instance-id>
bun run eliza1:vast-staging -- --only soak --include-soak --soak-ms 3600000 --base-url http://ssh3.vast.ai:<forwarded-port>
bun run eliza1:release-gates
```

Remote 3090 serving command shape:

```bash
llama-server --model /root/models/eliza-1-27b-256k.gguf --alias vast/eliza-1-27b-256k --host 127.0.0.1 --port 8080 --n-gpu-layers 99 --ctx-size 262144 --parallel 1 --metrics -fa on --jinja --reasoning-format none --chat-template-kwargs '{"enable_thinking":false}' --cache-type-k q4_0 --cache-type-v q4_0
```

## Release Evidence

The release gateboard requires fresh `status: "pass"` artifacts for:

| Gate | Evidence Source |
| --- | --- |
| Live Vast staging deploy | `scripts/eliza1-release-gates.mjs --probe-vast` or `eliza1:vast-staging` |
| 2B/9B/27B smoke | `eliza1:vast-staging --smoke-tier ...` against the actual tier endpoint |
| Streaming/tool-call parity | OpenAI plugin unit test plus live harness parity artifact |
| Cold-start and burst load | Live harness burst artifact with measured p95 and error rate |
| 1-hour soak | Live harness soak artifact with duration, crash-free status, and RSS budget |
| Failover kill | Live failover harness with explicit kill command and fallback endpoint |
| Cost reconciliation | Billing/cost job joining usage rows, ledger rows, and Vast spend |
| Billing records | Usage record, credit transaction, and idempotency key from the billing system |
| Dashboard alerts | Persisted alert evaluations and dashboard render verification |
| Eliza-1 quality/perf evals | Tiered eval reports from the Eliza-1 benchmark harness |

## Live Validation Notes, 2026-05-12

- Running Vast instance: 1x RTX 3090, instance `36201983`, external OpenAI-compatible URL `http://ssh3.vast.ai:11983`.
- Final Eliza artifact access is blocked without Hugging Face credentials: unauthenticated dry-run downloads for `elizaos/eliza-1`, `elizaos/eliza-1-2b`, and `elizaos/eliza-1-9b-polarquant` return 401. This blocks final 2B/9B/27B release smoke and quality/perf evals.
- Infrastructure staging uses `unsloth/Qwen3.6-27B-GGUF` file `Qwen3.6-27B-UD-Q3_K_XL.gguf` as a public stand-in. Evidence from this lane proves serving infrastructure only, not Eliza-1 model quality.
- The prebuilt CUDA llama-cpp-python server loads the 27B stand-in at 262144 context with q4_0 K/V cache and returns `/v1/models` plus non-stream chat.
- Live streaming tool-call shape parity passes, but streaming usage parity fails because the llama-cpp-python server does not emit usage in streaming chunks even when requested. This remains a release blocker.
- The custom elizaOS llama.cpp CUDA build applies the DFlash/QJL/Polar/TBQ patches but did not complete on the live 3090 image: `nvcc`/`cicc` spent over 35 minutes in `fattn.cu` with the narrower q4-KV config and was stopped. The next build wave should add a 3090-specific CMake profile that disables non-required TBQ/DFlash translation units for baseline staging, then compiles all-optimization artifacts separately.

## Release Command

`bun run eliza1:release-gates` fails until all required evidence is present and fresh. `--probe-vast` can write the live staging evidence when `VAST_STAGING_BASE_URL`, `VAST_STAGING_MODEL`, and `VAST_STAGING_INSTANCE_ID` are set.

`bun run eliza1:vast-staging -- --base-url http://ssh3.vast.ai:<forwarded-port>` collects live deploy, tier smoke, streaming/tool-call parity, and burst evidence from an OpenAI-compatible staging endpoint. Use `--include-soak` for the 1-hour soak and `--include-failover` with an explicit fallback URL plus kill command for the failover gate. Billing, cost reconciliation, dashboard alerts, and quality/perf evals must come from their real systems; the gateboard intentionally does not mint passing evidence for those.
