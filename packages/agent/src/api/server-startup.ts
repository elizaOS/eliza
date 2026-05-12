/**
 * Server startup orchestration — re-exported from server.ts.
 *
 * This module exists so that `startApiServer` can be imported from a
 * dedicated file. The implementation currently lives in server.ts due to
 * deep coupling with module-private state. A future refactoring pass
 * can move the ~1,400-line function body here once the internal helpers
 * are fully extracted to their own modules.
 *
 * Downstream consumers (e.g. `packages/agent/src/server/index.ts` and
 * `packages/app-core/src/runtime/dev-server.ts`) can import from either
 * `./server.js` or `./server-startup.js` — they re-export the same function.
 */

export type {
  AgentStartupDiagnostics,
  LogEntry,
  ServerState,
  ShareIngestItem,
  SkillEntry,
  StreamEventEnvelope,
  StreamEventType,
} from "./server.ts";
export { startApiServer } from "./server.ts";
