/**
 * Resolve the agent's API port for typed RPC handlers.
 *
 * The embedded `agent.getStatus().port` is the canonical source — but in
 * `dev:desktop` mode the agent runs in a separate `dev-server.ts` child
 * process spawned by the orchestrator, not under the electrobun bun
 * process's AgentManager. In that topology `status.port` stays null
 * forever and the typed-RPC handlers throw `AgentNotReadyError` on every
 * call, forcing every renderer-side wrapper to fall through to HTTP.
 *
 * The orchestrator already exports `ELIZA_API_PORT` into the electrobun
 * bun process's env (see `dev-platform.mjs`). So when the embedded status
 * doesn't know the port, fall back to `resolveDesktopApiPort(env)`. The
 * port we return is then used by the HTTP reader inside each composer.
 *
 * Returning null preserves the original "agent not ready" semantics —
 * the composer will throw `AgentNotReadyError` and the renderer falls
 * back to HTTP. We just won't return null spuriously when the agent is
 * actually up and reachable on a known port.
 */

import { resolveDesktopApiPort } from "@elizaos/shared";

export function resolveRpcAgentPort(
	embeddedPort: number | null,
	env: Record<string, string | undefined> = process.env,
): number | null {
	if (embeddedPort !== null && embeddedPort > 0) return embeddedPort;
	const fromEnv = resolveDesktopApiPort(env);
	return fromEnv > 0 ? fromEnv : null;
}
