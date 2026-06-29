# Issue 9940 remote plugin validation slice

## Scope

- `packages/agent/src/services/remote-plugin-bridge.ts`
  - Validates handled worker envelopes before dispatching `worker-announce-*`, `worker-rpc-result`, `worker-action-callback`, and `host-rpc`.
  - Validates remote action, provider, and route handler results at the worker RPC boundary.
  - Removes the empty provider fallback that turned invalid remote output into `{ values: {}, data: {}, text: "" }`.
  - Validates host RPC memory and event payloads before invoking runtime methods.
  - Rejects invalid route types instead of defaulting to `POST`.
- `packages/agent/src/services/remote-plugin-bridge.test.ts`
  - Covers invalid worker envelopes, malformed provider/action results, and malformed host RPC payloads.
- `packages/agent/src/services/remote-plugin-adapter.ts`
  - Validates remote evaluator processor payloads before treating them as local `ActionResult`s.
  - Validates response-handler patch fields before entering the response pipeline.
  - Validates app-bridge launch, auth, diagnostics, session, and app-route payloads.
  - Removes the `collectLaunchDiagnostics` empty-array fallback for malformed/missing remote output.
  - Distinguishes explicit app-route misses (`handled: false`) from malformed remote route responses.
- `packages/agent/src/services/remote-plugin-adapter.test.ts`
  - Covers malformed evaluator processor results, malformed response-handler patches, missing diagnostics, malformed app-route responses, and explicit app-route misses.
- `packages/agent/src/providers/media-provider.ts`
  - Replaces empty image-reference fallbacks in OpenAI, Google, xAI, and Anthropic vision providers with explicit `imageUrl` / `imageBase64` validation.
  - Returns a provider failure before remote fetch when image input is missing or blank.
- `packages/agent/src/providers/media-provider.test.ts`
  - Covers missing OpenAI image input, blank Google image input, and xAI URL trimming before request serialization.

## Validation

- `bunx @biomejs/biome check --write packages/agent/src/services/remote-plugin-bridge.ts packages/agent/src/services/remote-plugin-bridge.test.ts`
- `bunx vitest run --config packages/agent/vitest.config.ts packages/agent/src/services/remote-plugin-bridge.test.ts --coverage.enabled=false`
  - Result: 1 file passed, 10 tests passed.
- `bun run --cwd packages/agent typecheck`
- `git diff --check -- packages/agent/src/services/remote-plugin-bridge.ts packages/agent/src/services/remote-plugin-bridge.test.ts`
- `bunx @biomejs/biome check --write packages/agent/src/services/remote-plugin-adapter.ts packages/agent/src/services/remote-plugin-adapter.test.ts`
- `bunx vitest run --config packages/agent/vitest.config.ts packages/agent/src/services/remote-plugin-adapter.test.ts --coverage.enabled=false`
  - Result: 1 file passed, 41 tests passed, 3 skipped.
- `bun run --cwd packages/agent typecheck`
- `git diff --check -- packages/agent/src/services/remote-plugin-adapter.ts packages/agent/src/services/remote-plugin-adapter.test.ts`
- `bunx @biomejs/biome check --write packages/agent/src/providers/media-provider.ts packages/agent/src/providers/media-provider.test.ts`
- `bunx vitest run --config packages/agent/vitest.config.ts packages/agent/src/providers/media-provider.test.ts --coverage.enabled=false`
  - Result: 1 file passed, 10 tests passed.
- `bun run --cwd packages/agent typecheck`
- `git diff --check -- packages/agent/src/providers/media-provider.ts packages/agent/src/providers/media-provider.test.ts`
- Targeted search:
  - No matches for the removed empty provider fallback.
  - No matches for the previous handled-message casts in `remote-plugin-bridge.ts`.
  - No route proxy `as unknown as NonNullable<Plugin["routes"]>[number]` cast.
  - No evaluator processor `.result as never` or response-handler `.patch as never` casts remain in `remote-plugin-adapter.ts`.
  - No `imageUrl ?? ""` fallbacks remain in `media-provider.ts`.
