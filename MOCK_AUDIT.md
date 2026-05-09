# Mocked-test audit

Total files audited: 62 (one false-positive — `plugins/plugin-computeruse/test/computeruse-cross-platform.e2e.test.ts` only references `vi.mock` in a comment; treated as KEEP-PURE / out of scope).

- KEEP-PURE: 41 (≈173 test cases) — request-shape, request routing, transport plumbing, capacitor/native bridges, fs/clock/console stubs, OAuth flows with stubbed token endpoints, connector-account providers, send-handler registration, pure helper logic.
- DELETE: 7 (≈37 test cases) — pure larp around `ai`-package primitives. Mocks `generateText`/`generateObject` to return canned strings, then asserts the canned string flows through. Without a real provider behind it, the assertion proves nothing.
- CONVERT-LIVE: 13 (≈47 test cases) — propagation logic worth verifying against a real provider (token usage, trajectory recording, native tool plumbing, prompt-cache plumbing, Cerebras routing).
- MERGE-INTO-EXISTING-LIVE: 1 (1 test case) — bluesky integration already has live-skipIf path; the lone `vi.spyOn` block can be folded in.

Estimated work: ~10 plugins to touch, ~6 new live e2e files to write, ~7 files to delete outright.

## Conversion clusters

Group by needed env key / plugin so a single converter agent owns each cluster.

- **Cluster A — `ai` SDK trajectory + native plumbing across providers** (5 files): `plugin-openai/__tests__/trajectory.test.ts`, `plugin-openai/__tests__/native-plumbing.test.ts`, `plugin-google-genai/__tests__/trajectory.test.ts`, `plugin-nvidiacloud/__tests__/trajectory.test.ts`, `plugin-openrouter/__tests__/trajectory.test.ts`. One agent writes one shared "trajectory + native tool plumbing" live e2e per provider against the real key.
- **Cluster B — Ollama** (3 files): `plugin-ollama/__tests__/{model-usage,native-plumbing,smoke}.test.ts`. Convert to live e2e against a local Ollama (uses `OLLAMA_HOST`, free).
- **Cluster C — Eliza Cloud** (1 file): `plugin-elizacloud/__tests__/text-native-plumbing.test.ts`. Live e2e against `ELIZAOS_CLOUD_API_KEY`.
- **Cluster D — Groq / xAI / Cerebras config** (3 files): `plugin-groq/__tests__/model-usage.test.ts`, `plugin-xai/__tests__/plugin.test.ts` (xai is already a fetch-stub e2e — just retarget at real `XAI_API_KEY`), `plugin-openai/__tests__/cerebras-config.test.ts`. One agent.
- **Cluster E — local-ai** (1 file): `plugin-local-ai/__tests__/model-usage.test.ts`. Convert to live e2e against `node-llama-cpp` with a tiny GGUF in fixtures, OR delete — separate decision.
- **Bluesky** (1 file): merge `vi.spyOn(runtime, "registerEvent")` block into the existing `LIVE_TEST=true` branch.

The remaining 41 KEEP-PURE files require no agent work.

## Per-file table

| # | File | Lines | Tests | Mocks what | Classification | Conversion plan |
|---|------|-------|-------|------------|----------------|-----------------|
| 1 | packages/agent/src/api/accounts-routes.test.ts | 108 | 1 | account-pool + account-storage modules (in-memory route handler test) | KEEP-PURE | Tests pure HTTP route logic against in-memory pool. |
| 2 | packages/agent/src/api/connector-account-routes.test.ts | 807 | 10 | `@elizaos/core` connector-account-manager (in-memory) | KEEP-PURE | Pure route-handler tests with in-memory provider registry. |
| 3 | packages/agent/src/providers/media-provider.test.ts | 217 | 5 | `fetch` (asserts URL/headers/body shape sent to ElevenLabs/Cloud) | KEEP-PURE | Verifies request building, not response semantics. |
| 4 | packages/app-core/platforms/electrobun/src/desktop-http-request.test.ts | 85 | 3 | `fetch` (request-shape + timeout via fake timers) | KEEP-PURE | Transport-shape + timeout logic. |
| 5 | packages/app-core/src/api/android-native-agent-transport.test.ts | 99 | 2 | `@capacitor/core`, `fetch` | KEEP-PURE | Capacitor bridge routing logic. |
| 6 | packages/app-core/src/api/auth-pairing-compat-routes.test.ts | 234 | 3 | `@elizaos/core`, `@elizaos/agent`, auth/sessions, crypto.randomInt | KEEP-PURE | Pairing-route logic with deterministic crypto + session stubs. |
| 7 | packages/app-core/src/api/client-cloud-direct-auth.test.ts | 765 | 16 | `@capacitor/core` CapacitorHttp | KEEP-PURE | Asserts direct-Cloud auth never hits localhost on native. |
| 8 | packages/app-core/src/api/csrf-client.test.ts | 62 | 2 | boot-config + desktop-http-transport modules | KEEP-PURE | CSRF wrapper routing logic. |
| 9 | packages/app-core/src/api/desktop-http-transport.test.ts | 54 | 2 | electrobun-runtime + electrobun-rpc | KEEP-PURE | Routing logic — no real RPC needed. |
| 10 | packages/app-core/src/api/ios-local-agent-kernel.test.ts | 168 | 5 | `window`, `fetch` stubs | KEEP-PURE | iOS local agent kernel request handling. |
| 11 | packages/app-core/src/api/server-reset-hop.test.ts | 98 | 3 | `@elizaos/core` logger, `@elizaos/agent` workspace resolvers, `fetch` | KEEP-PURE | Filesystem-reset behavior; regression test for #7409. |
| 12 | packages/app-core/src/components/shell/RuntimeGate.cloud-provisioning.test.tsx | 868 | 13 | api client, state hooks, gateway-discovery, mobile-runtime-mode, capacitor, probe-local-agent, platform/init, utils, LanguageDropdown, `fetch` | KEEP-PURE | React component test with extensive deps mocked — pure UI state logic. |
| 13 | packages/app-core/src/navigation/main-tab.test.ts | 81 | 5 | `console.warn` spy | KEEP-PURE | Pure helper, console silencing. |
| 14 | packages/app-core/src/onboarding/mobile-runtime-mode.test.ts | 62 | 2 | `@capacitor/core`, `@capacitor/preferences` | KEEP-PURE | Persistence logic across localStorage + Capacitor. |
| 15 | packages/app-core/src/onboarding/probe-local-agent.test.ts | 131 | 5 | `@capacitor/core`, `fetch` | KEEP-PURE | Probe routing logic. |
| 16 | packages/app-core/src/state/startup-phase-runtime.test.ts | 53 | 1 | `../api` client | KEEP-PURE | State-machine routing for 401 → pairing path. |
| 17 | packages/core/src/__tests__/read-attachment-action.test.ts | 474 | 12 | `runtime.useModel` returns canned strings | DELETE | Asserts canned model output flows through `readAttachmentAction`. The action's value is "does it call useModel with the right prompt + parse the result" — the prompt-shape test could survive but the 12 cases overwhelmingly larp. Replace with a single live e2e against ANTHROPIC/OPENAI key that reads a real attachment. |
| 18 | packages/examples/bluesky/__tests__/integration.test.ts | 244 | 14 | `runtime.registerEvent` spy | MERGE-INTO-EXISTING-LIVE | File already has `describe.skipIf(!isLiveTest)` blocks. Fold the `registerEvent` spy block into the live branch. |
| 19 | plugins/app-contacts/src/providers/contacts.test.ts | 68 | 2 | `@elizaos/capacitor-contacts` Contacts plugin | KEEP-PURE | Capacitor bridge — provider data shaping. |
| 20 | plugins/app-lifeops/src/__tests__/privacy.test.ts | 305 | 8 | `@elizaos/core` (only re-exports of types/helpers; avoids loading advanced-capabilities) | KEEP-PURE | Pure privacy-filter logic. The `vi.mock` is to dodge a runtime-load side effect, not to fake behavior. |
| 21 | plugins/app-lifeops/src/website-blocker/chat-integration/__tests__/actions.test.ts | 195 | 3 | `actions/website-block` handler, `engine.getSelfControlStatus` | KEEP-PURE | Side-effecting host-file action stubbed; tests chat-integration glue. |
| 22 | plugins/app-lifeops/src/website-blocker/chat-integration/__tests__/block-rule-reconciler.test.ts | 162 | 5 | `actions/website-block` handler | KEEP-PURE | Reconciler logic against in-memory harness. |
| 23 | plugins/app-lifeops/src/website-blocker/chat-integration/__tests__/block-rule-service.test.ts | 132 | 6 | `actions/website-block` handler | KEEP-PURE | Service CRUD against in-memory harness. |
| 24 | plugins/app-lifeops/test/approval.dispatch.integration.test.ts | 183 | 2 | `LifeOpsService.sendTelegramMessage`/`sendGmailReply`, `runtime.useModel`, queue methods | DELETE | File header explicitly says "argument-routing test, not a dispatch integration test." Asserts `useModel` returns a canned JSON, then routes through. Replace with a live e2e (bot tokens) OR delete; recommend DELETE since the comment notes a "real dispatch integration test" should use a live harness — punt to that. |
| 25 | plugins/app-lifeops/test/book-travel.approval.integration.test.ts | 619 | 2 | `fetch` stubGlobal | KEEP-PURE | Stubs Duffel + Google APIs at fetch boundary; asserts approval-queue + token-resolution wiring. Worth keeping as a high-leverage integration test. |
| 26 | plugins/app-lifeops/test/native-parameters.test.ts | 138 | 3 | `@elizaos/agent/security/access`, approval-queue | KEEP-PURE | Pure native-parameters arg-resolution logic. |
| 27 | plugins/app-lifeops/test/notifications-push.e2e.test.ts | 217 | 11 | `fetch` stubGlobal | KEEP-PURE | Self-documents as offline-by-default with a `describe.skipIf(!LIVE_BASE_URL)` live block already present. Fetch-mocked branch covers HTTP-layer config/error handling. |
| 28 | plugins/app-lifeops/test/travel-duffel.integration.test.ts | 544 | 18 | `fetch` stubGlobal | KEEP-PURE | Same pattern as #27 — `describe.skipIf(!LIVE_API_KEY)` live block plus fetch-mocked offline coverage. Mocked branch verifies request shape + response mapping. |
| 29 | plugins/app-phone/src/actions/place-call.test.ts | 54 | 2 | `@elizaos/capacitor-phone` Phone plugin | KEEP-PURE | Number normalization + native bridge call. |
| 30 | plugins/app-training/src/core/trajectory-task-datasets.test.ts | 287 | 4 | `console.warn` spy | KEEP-PURE | Pure dataset-extraction logic. |
| 31 | plugins/plugin-agent-orchestrator/__tests__/unit/acp-service.test.ts | 500 | 11 | `node:child_process.spawn` | KEEP-PURE | Spawning real ACP processes is unreasonable in unit tests. Mocked spawn + EventEmitter exercises stdout/stderr framing. |
| 32 | plugins/plugin-agent-orchestrator/src/__tests__/swarm-decision-loop.test.ts | 344 | 17 | `task-validation.validateTaskCompletion` | KEEP-PURE | Pure decision-loop branching logic; the validator boundary is correctly stubbed. |
| 33 | plugins/plugin-browser/src/routes/browser-bridge-companion-revoke.test.ts | 123 | 1 | `@elizaos/core` logger, agent rate-limiter, integration-observability | KEEP-PURE | Pure route-handler test. |
| 34 | plugins/plugin-calendly/src/connector-account-provider.test.ts | 328 | 4 | `fetch` stubGlobal (Calendly OAuth token + me endpoints) | KEEP-PURE | OAuth flow request-shape + credential-storage logic. |
| 35 | plugins/plugin-computeruse/src/__tests__/trajectory.test.ts | 58 | 1 | `platform/screenshot`, `platform/a11y` | KEEP-PURE | OSWorld adapter trajectory-capture — platform layer correctly stubbed. |
| 36 | plugins/plugin-computeruse/test/computeruse-cross-platform.e2e.test.ts | 146 | 1 | (none — `vi.mock` only appears in a doc comment) | KEEP-PURE | False positive; this is a real e2e. |
| 37 | plugins/plugin-elizacloud/__tests__/text-native-plumbing.test.ts | 227 | 3 | `utils/sdk-client` createCloudApiClient (returns canned chat-completion JSON) | CONVERT-LIVE | Asserts native tools/schemas/cache keys land in OpenRouter request body. Run live with `ELIZAOS_CLOUD_API_KEY`; assert request body via fetch interceptor at the SDK boundary, not via mock. |
| 38 | plugins/plugin-feishu/src/connector.test.ts | 60 | 1 | `runtime.registerMessageConnector` mock-call inspection | KEEP-PURE | Verifies connector registration metadata. |
| 39 | plugins/plugin-github/src/accounts.test.ts | 419 | 7 | `fetch` stubGlobal (GitHub OAuth token + user endpoints) | KEEP-PURE | OAuth flow request-shape + token-vault wiring. |
| 40 | plugins/plugin-google-chat/src/connector.test.ts | 125 | 2 | `service.sendMessage` spy + `registerMessageConnector` inspection | KEEP-PURE | Connector registration metadata + send routing. |
| 41 | plugins/plugin-google-genai/__tests__/trajectory.test.ts | 110 | 1 | `utils/config` createGoogleGenAI factory + `fetch` | CONVERT-LIVE | Asserts trajectory recordLlmCall fires for text/object/image. Run live with `GOOGLE_GENERATIVE_AI_API_KEY`. |
| 42 | plugins/plugin-google/src/index.test.ts | 1095 | 15 | `fetch` stubGlobal (Google OAuth + token endpoints) | KEEP-PURE | OAuth + capability-derivation logic, request shape. |
| 43 | plugins/plugin-groq/__tests__/model-usage.test.ts | 162 | 3 | `@ai-sdk/groq`, `ai` (generateText/Object) | CONVERT-LIVE | Asserts MODEL_USED events emit accurate token counts. Run live with `GROQ_API_KEY`. |
| 44 | plugins/plugin-line/src/connector.test.ts | 56 | 1 | `service.sendLocationMessage` spy + connector inspection | KEEP-PURE | Connector registration + location-send routing. |
| 45 | plugins/plugin-linear/src/actions/routers.test.ts | 143 | 5 | `createIssueAction.handler`, `createCommentAction.handler` spies | KEEP-PURE | Router classification + delegation, not Linear API. |
| 46 | plugins/plugin-local-ai/__tests__/model-usage.test.ts | 174 | 1 | environment, downloadManager, platform, tokenizerManager, transcribeManager, ttsManager, visionManager, `node-llama-cpp` | DELETE | Mocks every dependency including `node-llama-cpp` itself, then asserts the plugin returns a string. Pure larp. Replace with a live e2e that actually loads a tiny GGUF, or accept that local-ai has no automated coverage. |
| 47 | plugins/plugin-matrix/src/__tests__/connector.test.ts | 105 | 2 | `service.sendMessage` spy + connector inspection | KEEP-PURE | Connector registration + send routing. |
| 48 | plugins/plugin-nvidiacloud/__tests__/trajectory.test.ts | 78 | 1 | `ai` generateObject, `providers/nvidia` factory | CONVERT-LIVE | Run live with `NVIDIA_API_KEY` against NVIDIA NIM. |
| 49 | plugins/plugin-ollama/__tests__/model-usage.test.ts | 172 | 2 | `ai`, `ollama-ai-provider-v2`, `models/availability` | CONVERT-LIVE | Run live against local Ollama (`OLLAMA_HOST`, default `http://localhost:11434`). |
| 50 | plugins/plugin-ollama/__tests__/native-plumbing.test.ts | 404 | 14 | `ai`, `ollama-ai-provider-v2`, `models/availability` | CONVERT-LIVE | Run live against local Ollama; asserts native ToolSet plumbing — must verify against the real `ai` package boundary. |
| 51 | plugins/plugin-ollama/__tests__/smoke.test.ts | 113 | 12 | `ai`, `ollama-ai-provider-v2`, `models/availability` | DELETE | Smoke test that asserts the plugin object has a name and handler functions exist. After mocking the entire `ai` SDK to import the plugin, no real signal remains. The "plugin shape" assertions are tautological. |
| 52 | plugins/plugin-openai/__tests__/cerebras-config.test.ts | 156 | 8 | `globalThis.fetch` spy | CONVERT-LIVE | Local-embedding fallback test (deterministic, no fetch) is KEEP-worthy, but Cerebras-routing tests that "uses the remote embedding API when configured" should run against `CEREBRAS_API_KEY` for real Cerebras + `OPENAI_API_KEY` for OpenAI compat. Split into two files or one live e2e. |
| 53 | plugins/plugin-openai/__tests__/native-plumbing.test.ts | 316 | 6 | `ai` generateText, `providers` factory | CONVERT-LIVE | Run live with `OPENAI_API_KEY` to verify messages/tools/toolChoice/schema/providerOptions are accepted by the real model. |
| 54 | plugins/plugin-openai/__tests__/trajectory.test.ts | 171 | 3 | `ai` (via `vi.doMock`), `providers` factory, `fetch` | CONVERT-LIVE | Run live with `OPENAI_API_KEY` to verify recordLlmCall + image generation pass through. |
| 55 | plugins/plugin-openrouter/__tests__/trajectory.test.ts | 67 | 1 | `ai` generateObject, `providers` factory | CONVERT-LIVE | Run live with `OPENROUTER_API_KEY`. |
| 56 | plugins/plugin-roblox/__tests__/integration.test.ts | 243 | 11 | `runtime.getService` to inject a mock RobloxService with vi.fn methods | KEEP-PURE | Action-routing logic — service boundary correctly stubbed. The Roblox HTTP API is not the unit under test. |
| 57 | plugins/plugin-signal/src/connector.test.ts | 150 | 4 | `service.sendMessage` spy + connector inspection | KEEP-PURE | Connector registration + send routing. |
| 58 | plugins/plugin-slack/src/connector-account-provider.test.ts | 295 | 4 | `fetch` stubGlobal (Slack OAuth) | KEEP-PURE | OAuth flow request-shape + credential-vault wiring. |
| 59 | plugins/plugin-suno/src/actions/musicGeneration.test.ts | 69 | 1 | `@elizaos/core` (recordLlmCall), `fetch` | DELETE | Mocks `recordLlmCall`, mocks `fetch` to return a canned id, then asserts both were called. Tautology. Replace with a live e2e against `SUNO_API_KEY` if Suno coverage matters; otherwise delete. |
| 60 | plugins/plugin-wallet/src/chains/wallet-router.test.ts | 294 | 7 | `runtime.getService` injects fake WalletBackendService + chain handlers | KEEP-PURE | Router dispatch logic to registered chain handlers — exactly the polymorphism allowed under AGENTS.md rule 5. |
| 61 | plugins/plugin-x/src/connector-account-provider.test.ts | 214 | 2 | `fetch` stubGlobal (X OAuth2 token + users/me) | KEEP-PURE | OAuth flow request-shape + credential-vault wiring. |
| 62 | plugins/plugin-xai/__tests__/plugin.test.ts | 128 | 4 | `fetch` stubGlobal (xAI chat-completions + embeddings) | DELETE | Asserts MODEL_USED events fire after a fetch-stubbed response. Once `ai` SDK changes call shape, the stub passes while real xAI breaks. Convert or delete; recommend DELETE in favor of one live xAI e2e in cluster D. |

---

## Follow-up findings (post-conversion sweep)

### Pre-existing test failure: plugin-anthropic native-plumbing.shape.test.ts

`plugins/plugin-anthropic/__tests__/native-plumbing.shape.test.ts` ships
with **1 failing test (7 passing)** on HEAD, predating the mock-to-live
conversion. The failure is at line 449:

```
expect(cached.length).toBeGreaterThan(0); // received 0
```

The test scenario at line 410 passes both `messages` AND `promptSegments`
with one stable + one dynamic part, plus `providerOptions.anthropic.cacheControl`.
It expects stable parts to land in `call.messages[*].content` with
`providerOptions.anthropic.cacheControl` set.

But the test at line 178 (in the same file, same scenario shape) expects
the leading user message to contain ONLY the dynamic part:
```
expect(call.messages[0]).toEqual({
  role: "user",
  content: [{ type: "text", text: "dynamic context" }],
});
```

These two expectations are mutually exclusive. The current implementation
of `buildSegmentedUserContentForMessages` filters to dynamic-only, which
satisfies the line-178 test but breaks the line-449 test.

To resolve this properly, an Anthropic-cache-control SME needs to decide
which design is intended:
- **Option A**: stable parts go to `call.system` only (not `call.messages`).
  Then line 449 should scan `call.system` for cache_control instead.
- **Option B**: stable parts go to wire user content with cache_control,
  not to system. Then line 178 needs to expect both stable + dynamic parts.

Either way, one test or the other needs adjustment to match the chosen design.

This bug is unrelated to the mock-to-live conversion and was inherited
from HEAD. Marking it out of scope for the test cleanup work.
