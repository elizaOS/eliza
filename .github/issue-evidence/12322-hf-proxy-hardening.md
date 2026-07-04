# Issue #12322 — HF proxy and downloader hardening

## What changed

- HuggingFace resolve URLs now carry ordered download candidates so a cloud-linked proxy URL can be tried before direct HuggingFace, with direct fallback for transient failures.
- The Cloudflare HF proxy now refuses out-of-catalog repos, returns structured `HF_GATED` responses for 401/403, records per-org egress usage, and enforces a configurable monthly egress budget before streaming large responses.
- The local downloader now retries/fails over across candidate bases for foreground and native-background downloads while preserving typed gated-repo failures through the consumer-facing job status.

## Verification

Commands run in `/tmp/eliza-12322-hf-proxy` on branch `fix/12322-hf-proxy-hardening`:

```bash
bun install
bun run --cwd packages/shared test src/local-inference/hf-proxy.test.ts
bun run --cwd packages/cloud/routing build
node packages/shared/scripts/generate-keywords.mjs --target ts
bun run --cwd packages/cloud/api test __tests__/hf-proxy-route.test.ts
bun run --cwd plugins/plugin-local-inference test src/services/downloader.test.ts
```

Results reviewed:

- `packages/shared` HF proxy URL tests: 1 file, 5 tests passed.
- `packages/cloud/api` HF proxy route tests: 1 file, 8 tests passed, including auth, allowlist rejection, cloud-token forwarding, structured `HF_GATED`, and monthly egress-budget enforcement.
- `plugins/plugin-local-inference` downloader tests: 1 file, 26 tests passed, including transient hub retry, candidate failover, typed gated-repo status propagation, bundle install/resume/stale-content handling, keep-awake behavior, and native background download coverage.

## Evidence Matrix

- Backend logs: covered by route assertions against structured `[hf-proxy] proxied download` and `[hf-proxy] egress metric` logger payloads.
- Frontend screenshots/video: N/A — this chunk changes backend proxy/runtime download behavior only; no UI surfaces were modified.
- Real-LLM trajectories: N/A — no prompts, actions, providers, model selection, or agent-response behavior changed.
- Domain artifacts: N/A — no persisted model bundle was downloaded from the live gated repo in this local evidence run; tests exercise the real downloader state machine with deterministic local HTTP responses.
- Benchmarks: N/A — no performance-sensitive decoding/training path changed.
