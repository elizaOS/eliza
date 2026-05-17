/**
 * PtySessionsContext — isolated context for PTY session list.
 *
 * ptySessions updates every ~5 seconds via polling. Keeping it in
 * AppContext would cascade those polls to every useApp() subscriber.
 * This context lets only the orchestrator widget and scene overlay
 * re-render on session changes.
 */
import type { CodingAgentSession } from "../api/client";
export interface PtySessionsValue {
  ptySessions: CodingAgentSession[];
}
export declare const PtySessionsCtx: import("react").Context<PtySessionsValue>;
export declare function usePtySessions(): PtySessionsValue;
//# sourceMappingURL=PtySessionsContext.d.ts.map
