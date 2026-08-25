# plugin-linear guide

Read `README.md` first; it is the factual surface contract. Repository-wide
rules in the root guide remain binding.

## Architecture

- `src/client.ts` owns the only outbound HTTP path. Every request goes through
  core's SSRF-guarded transport with one deadline, one byte limit, and manual
  redirect rejection. Do not add a second fetch path or widen the endpoint
  validation.
- `src/service.ts` owns credential resolution (`LINEAR_OAUTH_TOKEN` then
  `LINEAR_API_KEY`). Missing credentials throw typed
  `LINEAR_NOT_CONFIGURED`; never return a healthy-looking empty page instead.
- `src/action.ts` is the planner boundary (`error-policy:J1`). It translates
  `LinearError` only; programming errors must keep throwing.
- All response payloads are untrusted until the zod schemas in `src/types.ts`
  accept them. Workflow-state types are a closed enum — extend the enum
  deliberately; do not loosen it to `z.string()`.

## Scope invariants

- The plugin is read-only. Adding a write action requires the epic #19877
  write-policy/receipt contracts (`capability:write`,
  `effect:receipt-required` tags plus a settlement path); do not ship a write
  without them.
- Credentials must never appear in URLs, results, logs, errors, fixtures, or
  test snapshots. The unit suite asserts redaction; keep those tests passing.

## Validation

```bash
bun run --cwd plugins/plugin-linear test
bun run --cwd plugins/plugin-linear typecheck
bun run --cwd plugins/plugin-linear lint:check
```

The provider-contract lane in `test/provider-contract.test.ts` must keep
covering the full outbound-http + pagination scenario catalog; removing a
scenario fails `runProviderAdapterConformance`.
