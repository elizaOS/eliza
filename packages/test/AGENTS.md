# @elizaos/test-harness

The repo's shared, test-only substrate. It ships the **deterministic mock-LLM
proxy** and the `withMockLlmRuntime()` helper (a real PGLite-backed
`AgentRuntime` with no provider key and zero cost), the **shared Vitest config
matrix** every package extends, the **LifeOps external-API mocks** (Mockoon
environments), the workspace's **`.scenario.ts` fixtures**, and two nested
private workspace packages: `cloud-e2e` (Playwright full-stack E2E) and
`cloud-test-mocks` (stateful in-process mocks of cloud provider APIs).

`package.json` name is `@elizaos/test-harness` (`private`, version `0.0.0`); it
is consumed from other packages' `devDependencies` as `workspace:*`.

## Layout

```
harness/        @elizaos/test-harness public entry — withMockLlmRuntime(),
                the deterministic LLM proxy plugin, action-route fixtures, and
                the adversarial negative-fixture pack. Own vitest.config.ts.
mocks/          LifeOps external-API mocks: Mockoon environments/ (twilio,
                whatsapp, google, slack, discord, openai, anthropic, …) served
                in-process via scripts/start-mocks.ts; helpers/ holds the
                llm-proxy-plugin re-exported by harness/. See mocks/README.md.
helpers/        cross-package test utilities — action assertions/spies/benchmark,
                conversation-harness, real-runtime/live-provider re-exports.
vitest/         the shared Vitest config matrix (default / unit / integration /
                e2e / real / live-e2e / real-qa configs) + workspace-aliases.ts
                (resolves @elizaos/* to source). Extended across the monorepo.
scenarios/      the workspace .scenario.ts library (lifeops.*, convo, gateway,
                connector-certification, goals, …) plus _helpers.
cloud-e2e/      @elizaos/cloud-e2e — Playwright E2E booting a full mock-backed
                cloud-api + cloud-frontend stack. See cloud-e2e/README.md.
cloud-mocks/    @elizaos/cloud-test-mocks — stateful Hetzner + control-plane
                mocks (./hetzner, ./control-plane exports + bins). README.md.
scripts/        thin re-exports of app-core test scripts (test-parallel, etc.).
eliza-package-paths.ts   re-export shim over app-core/test/eliza-package-paths.
```

## Exports (`@elizaos/test-harness`)

| Subpath | Provides |
| --- | --- |
| `.` | `withMockLlmRuntime`, `strictActionRouteFixtures`, the negative-pack helpers, the proxy factory + types |
| `./llm-proxy` | `createDeterministicLlmProxyPlugin` and its types directly |
| `./negative-fixtures` | the adversarial fixture pack (`ADVERSARIAL_KINDS`, `adversarialActionRouteFixtures`) |
| `./action-route-fixtures` | the action-route fixture template |

`cloud-test-mocks` exports `.`, `./hetzner`, `./control-plane` and the
`hetzner-mock` / `control-plane-mock` bins.

## Key scripts

```bash
# this package's own harness unit tests
bun run --cwd packages/test test          # vitest run (harness/vitest.config.ts, --passWithNoTests)

# nested cloud packages
bun run --cwd packages/test/cloud-e2e test          # Playwright E2E (headless)
bun run --cwd packages/test/cloud-e2e typecheck
bun run --cwd packages/test/cloud-mocks test
bun run --cwd packages/test/cloud-mocks start:hetzner -- --port 4567

# from the repo root
bun run cloud:e2e        # = cloud-e2e test ; also cloud:e2e:headed / cloud:e2e:ui
bun run cloud:mock       # boot the local mock cloud stack
bun run cloud:login:test-wallet   # real SIWE login probe against a stack
```

`packages/test` is included in the `test:server` lane.

## Conventions / gotchas

- **Keyless by default.** `withMockLlmRuntime()` wraps
  `@elizaos/core/testing`'s `createRealTestRuntime` (real PGLite runtime) and
  registers the deterministic proxy at `priority: 1000` so it wins dispatch for
  every text `ModelType` plus `TEXT_EMBEDDING`. `strict` defaults to `true`:
  every model call must match a declared fixture or the proxy throws with
  diagnostics. Always `await harness.cleanup()` (use `try/finally`) and call
  `harness.assertFixturesConsumed()`.
- **Declare both response paths.** Plugin e2e should cover correct routing
  (`strictActionRouteFixtures`) *and* adversarial inputs
  (`adversarialActionRouteFixtures` — `malformed-json`, `wrong-tool`,
  `hallucinated-tool`, `empty`, `truncated`) — never assume only happy paths.
- **Full message-turn flows belong in scenarios.** For inbound→routing→action→
  outbound, prefer a deterministic `.scenario.ts` via `SCENARIO_USE_LLM_PROXY`;
  the harness helper is for action/provider/service-level e2e.
- **Source-resolved aliases.** `harness/source-aliases.ts` and
  `vitest/workspace-aliases.ts` resolve `@elizaos/*` to source so a real runtime
  boots independent of build order; keep the two alias sets in sync.
- **Test-only env vars.** The `ELIZA_MOCK_*` base URLs (see `mocks/README.md`)
  are opt-in for tests; `bun run dev` strips inherited values so local dev keeps
  hitting real services. Do not export them in your dev shell.
- **cloud-e2e is local + mock-backed.** No real cloud creds; the memory sandbox
  provider is guarded by `NODE_ENV=test` / `CLOUD_E2E=1`. The `seededUser`
  fixture authenticates via the genuine SIWE handshake. Do **not** edit
  cloud-api / cloud-frontend source from inside this package — surface bugs as
  follow-ups.
- **cloud-test-mocks state is in-memory** and resets on process exit; point the
  real client at it with `HCLOUD_API_BASE_URL` (`MOCK_HETZNER_ACTION_MS` tunes
  the action lifecycle).
- The Vitest naming convention (`*.test.ts` / `*.integration.test.ts` /
  `*.e2e.test.ts` / `*.real.test.ts` / `*.live.test.ts` / `*.spec.ts`) and which
  config runs each is documented at the top of `vitest/default.config.ts`.

Repo-wide rules (logger-only, ESM, naming, architecture) are in the root [AGENTS.md](../../AGENTS.md).

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — eval / trajectory harness:**
- A live-model scenario run producing the JSON report + run viewer + native jsonl, with the trajectory **opened and reviewed**.
- The harness's own e2e tests against a real `AgentRuntime` — not a mocked runtime; assert **outcomes**, not routing (see #9970).
- Determinism/seed handling and the failure/partial-run reporting paths.
- The shape of the corpus/records emitted, inspected by hand.
<!-- END: evidence-and-e2e-mandate -->
