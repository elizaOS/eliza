# @elizaos/testing

Private workspace for repository-wide scenarios and deterministic runtime, model, database and connector test fixtures. This package is not published. Fixture helpers stay separate from the synthetic-world control subpath.

Use `createDeterministicModelPlugin` with explicit fixtures and assert their consumption. Unexpected requests and exhausted fixtures fail; do not replace those failures with canned catch-all success. Use `createTestRuntimeWithModelProvider` to execute the real runtime against local PGlite. Live-provider helpers are opt-in and distinct from required deterministic tests.

Register `onTestFinished(harness.cleanup)` immediately after acquiring a per-test model runtime, or use the existing suite teardown hook for suite-owned runtimes. Avoid assertion-body `try/finally` cleanup: a leftover-fixture error would replace the original assertion error. Vitest teardown reports both failures.

Run `bun run --cwd packages/testing test` and `bun run --cwd packages/testing typecheck`.

For ephemeral storage, import `SQLiteDatabaseAdapter` or `initializeTestRuntime` from `@elizaos/testing/sqlite-adapter`. The helper registers isolated storage only when the test has supplied no adapter, then calls the real runtime initialization. Production hosts must choose their own persistence explicitly.

`@elizaos/testing/capability-protocol-fixture` supplies the canonical protocol
payloads for capability-router tests and the local conformance server. Production
core exports protocol types and execution, not fixture data.

## Shared scenario corpus

Repository-wide scenarios live in `scenarios/`; product-specific scenarios stay
with their owning packages and plugins. Run `test:scenarios` for corpus guard
tests and full scenario validation, or `scenarios:validate` for discovery alone.
The package `test` and `typecheck` commands cover fixtures, scenarios, and evidence.
Live-model scenario execution remains explicit through the scenario runner.

## Evidence and certification

[Evidence tooling](evidence/README.md) provides signed bundles, artifact analysis,
visual QA, video ingestion, and certification. Import `@elizaos/testing/evidence`
or its `visual-primitives` subpath. The package test and typecheck commands also
cover evidence; use `test:evidence` and `typecheck:evidence` for focused checks.
Bundle and certification commands run from this workspace, for example
`bun run --cwd packages/testing bundle:create -- --tier cpu`.

## Scenario execution and synthetic worlds

`scenario-runner/` owns discovery, schemas, the scenario CLI and real-runtime
execution. Import `@elizaos/testing/scenario-runner` and its `/schema` subpath.
`synthetic-world/` owns fenced command journals and production controllers;
import `@elizaos/testing/synthetic-world`. Both are part of this workspace,
with no nested package manifests.

Use `test:runner`, `typecheck:runner`, `test:synthetic-world`, and
`typecheck:synthetic-world` for focused checks. The root package test and
typecheck commands include both. Runner CLI commands retain their names, such
as `bun run --cwd packages/testing test:pr:e2e`.

## Perfect-result end-to-end provider

`createPerfectResultPlugin` (also exported as `createDeterministicModelPlugin`)
uses scenario-authored responses at the inference boundary. It runs through normal
runtime model dispatch; it does not replace the runtime, SQL, actions, or delivery.
No API keys or network inference service are required.

Text fixtures may return text, a JSON response payload, or a native
`GenerateTextResult` with tool calls and usage. Native chat requests preserve the
structured result; prompt-only requests return text. Both callback streaming and
`stream: true` async iterators are supported. Usage is supplied by the fixture,
never fabricated as evidence of a real model call.

Declare non-text capabilities in a fixture's `match.modelType`. For predicate
matchers or fixtures registered after boot, also declare `modelTypes` in the
plugin/runtime options. Return the same values as the production provider:
`ArrayBuffer` for OpenAI speech, a string for transcription, numeric vectors for
embeddings, and image results for image models. `call.input` contains the original
request, including audio bytes. Speech fixtures should contain valid recorded or
generated audio bytes; the runtime voice test uses a silent PCM WAV to verify byte
delivery, not speech quality. Embedding fixtures must include the runtime's null
input dimension probe. Every unexpected, ambiguous, exhausted, or unconsumed
required fixture fails the scenario.

Run the runtime message, audio-dispatch and native-tool persistence flows:

```sh
bun test --conditions eliza-source packages/testing/e2e/perfect-result-runtime.e2e.test.ts
```

These scenarios exercise assistant routing, actual PGlite history writes,
transcription/speech model dispatch, and the production NOTES_CREATE action with
owner authorization and durable note-file readback, with and without a client
streaming callback. The native planner uses the provider iterator in both cases.
Audio transport and delivery are test-owned; these are not production voice
endpoint or Notes browser/WebSocket tests. It proves runtime behavior with known provider results;
model intelligence, recognition accuracy and audio quality are outside its scope.
