/** Hard cap from first agent-wait loop iteration (first successful getStatus). */
export declare const AGENT_STARTUP_ABSOLUTE_MAX_MS = 900000;
/** While the agent stays in `starting`, extend the deadline by this much (sliding). */
export declare const AGENT_STARTING_SLIDE_MS = 180000;
/**
 * Initial wait before the first sliding extension applies (avoids instant max deadline).
 */
export declare function getAgentReadyTimeoutMs(): number;
export declare function computeAgentDeadlineExtensions(options: {
  agentWaitStartedAt: number;
  agentDeadlineAt: number;
  state: string | undefined;
  now?: number;
}): number;
//# sourceMappingURL=agent-startup-timing.d.ts.map
