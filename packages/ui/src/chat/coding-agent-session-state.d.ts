import type { CodingAgentSession } from "../api/client-types-cloud";
export declare const STATUS_DOT: Record<string, string>;
export declare const PULSE_STATUSES: Set<string>;
export declare const TERMINAL_STATUSES: Set<string>;
export interface ServerTask {
  sessionId: string;
  agentType?: string;
  label?: string;
  originalTask?: string;
  workdir?: string;
  status?: string;
  decisionCount?: number;
  autoResolvedCount?: number;
}
export declare function mapServerTasksToSessions(
  tasks: ServerTask[],
): CodingAgentSession[];
//# sourceMappingURL=coding-agent-session-state.d.ts.map
