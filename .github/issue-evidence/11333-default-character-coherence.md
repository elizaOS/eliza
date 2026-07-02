# Issue #11333 — default Eliza character coherence

## Result

Restored the #11217 default-character invariants after the stale-base clobber:
the cloud signup character and runtime Eliza persona both allow recall from
visible stored memories, the recall example no longer denies memory wholesale,
and prompt topics are third-person to avoid referent confusion.

## Human-reviewed evidence

- `bun run --cwd packages/cloud/shared test src/lib/utils/default-eliza-character.test.ts`
  - Passed: 5 tests, 18 assertions.
  - Guards the scoped honesty rule, recall example, third-person topics,
    duplicate persona sync, and the web-search no-op invariant.
- `bunx @biomejs/biome check packages/cloud/shared/src/lib/utils/default-eliza-character.ts packages/cloud/shared/src/lib/eliza/agent.ts packages/cloud/shared/src/lib/utils/default-eliza-character.test.ts`
  - Passed.
- `bun run --cwd packages/cloud/shared typecheck`
  - Passed.
- Live model trajectory:
  - `.github/issue-evidence/11333-default-character-live-cerebras.json`
  - Provider/model: Cerebras `gemma-4-31b`.
  - Prompt used the restored `getDefaultElizaCharacterData().system` plus the
    user message `do you remember what i told you about my sister last month`.
  - Reviewed output: `i don't have any record of you mentioning your sister. if
    you want to tell me again, i'm listening.`
  - Reviewed assertions: response was non-empty, did not claim actual recall,
    and acknowledged limited visible context.

## Validation gaps / non-applicable artifacts

- No screenshots or video: this is a backend/default-persona prompt fix with no
  UI surface changed.
- `bun run --cwd packages/cloud/shared lint` is blocked by unrelated existing
  package-wide Biome findings in:
  - `src/db/repositories/__tests__/app-frontend-deployments.test.ts`
  - `src/db/schemas/apps.ts`
  - `src/lib/services/app-charge-requests.ts`
  - `src/lib/services/app-review.ts`
  - `src/lib/services/managed-domains.ts`
  - `src/lib/services/payment-adapters/oxapay.test.ts`
  - `src/lib/services/token-redemption-secure.ts`
- `bun run verify` is blocked before typecheck/lint by unrelated repo-wide
  type-safety ratchet drift:
  - `as unknown as`: `80 current > 77 baseline`.
  - ``?? {}`` in core/agent/app-core: `379 current > 377 baseline`.
