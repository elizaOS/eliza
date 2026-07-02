# #11383 Capability Prompt Path Evidence

## Scope

- The `INBOX` `triage` subaction now fetches fresh cross-channel messages,
  calls `InboxService.triage`, and persists classifier results instead of only
  reading the existing queue.
- The inbox action description/routing hints now distinguish triage as the
  optimized-prompt classifier path.
- `inbox-triage-capability.scenario.ts` seeds scenario-scoped message adapters,
  adds an organic "triage my inbox" turn, requires a `purpose:
  "inbox_triage"` model call, and asserts one persisted triage row per seeded
  message.
- `plugins/plugin-inbox/test/inbox-action.test.ts` covers fresh-message
  classification, already-triaged filtering, and fail-closed classifier errors.

## Local validation

- `bun run --cwd plugins/plugin-inbox test -- test/inbox-action.test.ts`
- `bun run --cwd packages/scenario-runner test -- src/final-checks/index.test.ts src/native-export.test.ts`
- `git diff --check origin/develop...HEAD`

## Evidence gaps

- No live model provider key is present in this environment
  (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`,
  `GOOGLE_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, and
  `CEREBRAS_API_KEY` are unset), so the live trajectory recapture requested by
  #11383 still needs to run from a credentialed environment.
