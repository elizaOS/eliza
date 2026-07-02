# #10877 cloud API docs contract evidence

## Source-of-truth checks

- `packages/cloud/api/v1/containers/schema.ts` accepts create-container request keys `projectName`, `memoryMb`, `healthCheckPath`, and `environmentVars`; it does not accept `persistVolume`, `useHetznerVolume`, or `volume_size_gb`.
- `packages/cloud/api/v1/containers/route.ts` defaults create resources to `cpu: 1792` and `memoryMb: 1792`, and returns `{ success, data }` for create without a `polling` block.
- `packages/cloud/api/v1/containers/[id]/route.ts` uses the `PatchContainerSchema` `action` union: `restart`, `setEnv`, and `scale`.
- `packages/cloud/api/v1/apps/route.ts` returns the created app API key as `apiKey: result.apiKey`, a one-time plaintext string.

## Validation

```bash
bun run --cwd packages/docs test
```

Result: 15 tests passed.

## N/A artifacts

- Real-LLM trajectory: N/A, docs-only contract correction.
- Backend/frontend logs: N/A, no runtime code path changed.
- Screenshots/video: N/A for this local pass because `@elizaos/docs` has no repo build script; Mintlify preview is outside the package scripts. The docs navigation/link suite passed locally.
