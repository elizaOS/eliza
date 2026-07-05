# #13689 — chat-history relaunch persistence: real server-truth e2e

**Issue:** "My conversation is still there after I reopen the app" — the most
basic chat-correctness property — had no automated assertion that isn't
mock-substituted. The web spec (`conversation-management.spec.ts`) asserts
reload persistence against an **in-spec mock store**, so it proves client
rehydration, not the real agent-DB round trip. On boot the server rebuilds the
conversation list from database truth (`restoreConversationsFromDb`), but that
logic was an **un-exported closure inside `server.ts`** — untestable, which is
exactly why a relaunch-persistence regression can ship unseen.

## What this adds

1. **Extraction (makes the real path testable, not larp):**
   `packages/agent/src/api/conversation-restore.ts` — the web-chat conversation
   restore logic lifted out of the `server.ts` boot closure into an exported,
   dependency-injected function (`restoreConversationsFromDb(rt, { conversations,
   deletedConversationIds, log })`). `server.ts` now binds it to live server
   state and keeps the restore running as a non-blocking boot task whose errors
   are surfaced at the caller boundary.

2. **Real relaunch e2e:**
   `packages/app-core/src/api/conversation-restore-relaunch.test.ts` drives the
   **real** restore against a **real, migrated PGlite database** (no mocks):

   | Assertion | What it proves |
   |---|---|
   | seed room `web-conv-<id>` + marker message → fresh registry → restore | the conversation reappears from DB truth after a relaunch, mapped to its real room; the marker message is still readable via `getMemories` |
   | fresh registry, no persisted rooms → restore | restores **nothing** (no fabrication) — the negative check #13689 asks for |
   | non-web-chat room in the same world | ignored (only `web-conv-` rooms restore) |
   | restore into an already-populated registry | no duplicates (idempotent) |
   | id in `deletedConversationIds` | never resurrected |

## Evidence

- `verbose-run.txt` — `vitest --reporter=verbose`: real `[PLUGIN:SQL]`
  migrations (167 SQL statements, real FTS objects) and **4/4 passing**.

```bash
bun run --cwd packages/app-core test -- src/api/conversation-restore-relaunch.test.ts
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

## Scope

This is the **device-free, server-truth foundation** of #13689 — the property
all four surface legs depend on (a sent message survives relaunch because it is
read back from server truth, not optimistic client state). The per-surface
app-relaunch legs the issue also lists — **iOS sim / Android device / desktop
packaged** — remain gated on device toolchains/simulators not available in this
environment; the **web live-walkthrough** leg belongs to the nightly
`app-live-e2e` lane where a real backend is already running. Those are marked
N/A here (device/live-infra), not silently dropped.
