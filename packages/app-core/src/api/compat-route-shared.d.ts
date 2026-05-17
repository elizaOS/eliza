import type http from "node:http";
import { type ElizaConfig } from "@elizaos/agent";
import type { AgentRuntime } from "@elizaos/core";
export interface CompatRuntimeState {
    current: AgentRuntime | null;
    pendingAgentName: string | null;
    pendingRestartReasons: string[];
}
export declare function clearCompatRuntimeRestart(state: CompatRuntimeState): void;
export declare function scheduleCompatRuntimeRestart(state: CompatRuntimeState, reason: string): void;
export declare const DATABASE_UNAVAILABLE_MESSAGE = "Database not available. The agent may not be running or the database adapter is not initialized.";
export declare function isLoopbackRemoteAddress(remoteAddress: string | null | undefined): boolean;
/**
 * Same-machine dashboard access. This is intentionally stricter than just
 * checking `remoteAddress`: the browser must also be targeting a loopback Host
 * and must not present cross-site browser metadata.
 */
export declare function isTrustedLocalRequest(req: Pick<http.IncomingMessage, "headers" | "socket">): boolean;
export declare function readCompatJsonBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<Record<string, unknown> | null>;
export declare function hasCompatPersistedOnboardingState(config: ElizaConfig): boolean;
export declare function getConfiguredCompatAgentName(): string | null;
/**
 * Best-effort grab of the Drizzle DB handle off the live runtime adapter.
 * Returns null when the runtime is not yet up or the adapter has not
 * exposed a `db` field. Callers MUST treat null as "service unavailable"
 * — it is never authentication.
 */
export declare function getCompatDrizzleDb(state: CompatRuntimeState): unknown | null;
//# sourceMappingURL=compat-route-shared.d.ts.map