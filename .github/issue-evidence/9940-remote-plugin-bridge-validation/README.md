# Issue #9940 - remote plugin bridge boundary validation

## Scope

- Added Zod validation for handled remote-plugin worker envelopes before dispatch.
- Validated worker action/provider/route results before returning them to runtime surfaces.
- Validated host runtime RPC arguments for memory-shaped payloads and event payloads before invoking runtime methods.
- Injected the host runtime into emitted event payloads after payload-shape validation.
- Removed `as unknown as` casts from `packages/agent/src/services/remote-plugin-bridge.ts`.

## Verification

```bash
bun run --cwd packages/agent test src/services/remote-plugin-bridge.test.ts
bun run --cwd packages/agent typecheck
bun run --cwd packages/agent lint
```

All commands passed locally.
