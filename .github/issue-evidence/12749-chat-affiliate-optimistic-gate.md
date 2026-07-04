# Issue #12749 — chat affiliate optimistic billing gate

## Change

- `/v1/chat/completions` now disables both optimistic billing branches when
  `X-Affiliate-Code` is present.
- Affiliate-marked requests fall through to the synchronous `reserveCredits`
  path, where affiliate markup is included in the upfront hold.
- Added route-decision regression coverage for both optimistic backends:
  - KV pending-charge path bypassed when `X-Affiliate-Code` is present.
  - DB ledger path bypassed when `X-Affiliate-Code` is present, with a no-header
    positive control proving the DB optimistic branch still admits normal calls.

## Local Verification

- PASS: `bunx @biomejs/biome check packages/cloud/api/v1/chat/completions/route.ts packages/cloud/api/__tests__/chat-completions-optimistic-billing.test.ts`

## Attempted / Blocked

- `bun run --cwd packages/cloud/api test -- __tests__/chat-completions-optimistic-billing.test.ts`
  - blocked before assertions by current workspace build artifact resolution:
    `SyntaxError: Export named 'ElizaError' not found in module 'packages/core/dist/index.d.ts'`.
- `NODE_OPTIONS='--conditions=eliza-source' bun run --cwd packages/cloud/api test -- __tests__/chat-completions-optimistic-billing.test.ts`
  - same blocker.
- `bun run --cwd packages/cloud/api typecheck`
  - blocked by existing workspace dependency declaration resolution for
    `@elizaos/auth/*` imports from `packages/app-core/src/services/*`.

## Evidence N/A

- Screenshots/video: N/A — backend billing route guard, no UI.
- Real LLM trajectories: N/A — no model, prompt, provider, action, or evaluator
  behavior changed.
- Runtime cloud stack trace: not captured locally because the focused unit test
  and package typecheck are blocked by unrelated workspace build/declaration
  issues before reaching this route.
