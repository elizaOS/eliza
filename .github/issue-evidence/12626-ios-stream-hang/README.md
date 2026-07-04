# iOS local-agent stream termination evidence

## Scope

Fixes #12626 stream lifecycle regressions:

- Native-call rejection before the response head now rejects the shared streaming response head, allowing the iOS buffered fallback/error path to run instead of hanging forever.
- Mid-stream WebView/native `stream_emit` rejection no longer poisons the serialized chunk queue before the terminal frame; the bridge attempts a final `complete` frame with the emit error.

## Verification

- `bun install --ignore-scripts` in a clean `origin/develop` export - PASS.
- `bun run --cwd packages/cloud/routing build` - PASS, required for the bridge test import graph in the clean export.
- `node packages/shared/scripts/generate-keywords.mjs --target ts` - PASS, required for core generated keyword data in the clean export.
- `bunx vitest run packages/ui/src/api/native-agent-stream.test.ts packages/ui/src/api/ios-streaming-agent-plugin.test.ts plugins/plugin-capacitor-bridge/src/ios/bridge.stream.test.ts` - PASS, 3 files / 21 tests.
- `bunx biome check packages/ui/src/api/native-agent-stream.ts packages/ui/src/api/native-agent-stream.test.ts packages/ui/src/api/ios-streaming-agent-plugin.ts packages/ui/src/api/ios-streaming-agent-plugin.test.ts plugins/plugin-capacitor-bridge/src/ios/bridge.ts plugins/plugin-capacitor-bridge/src/ios/bridge.stream.test.ts` - PASS.

## Typecheck status

- `bun run --cwd packages/ui typecheck` - BLOCKED by unrelated existing workspace errors, including unresolved `@elizaos/contracts` and pre-existing `AccountWithCredentialFlag` field errors in account UI files.
- `bun run --cwd plugins/plugin-capacitor-bridge typecheck` - BLOCKED by unrelated existing workspace errors, including unresolved optional `@elizaos/auth`, plugin, contracts, security, and skills packages.

## Evidence matrix

- Live model trajectories: N/A - no prompt, provider, action, evaluator, or model selection behavior changed.
- Screenshots/video: BLOCKED - this host has Command Line Tools only; no full Xcode/iOS simulator SDK is installed.
- Native/iOS device logs: BLOCKED - no iOS simulator/device runtime is available on this host.
- Backend/client logs: covered by focused in-process stream tests; no live app runtime was available for device capture.
