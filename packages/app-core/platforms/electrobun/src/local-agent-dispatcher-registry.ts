/**
 * Process-wide registry for the active desktop local-agent dispatcher (#12180 /
 * #12355). The `localAgentRequest` RPC handler resolves the dispatcher from here
 * rather than importing the agent-child lifecycle directly, keeping the handler
 * decoupled from spawn/readiness plumbing and unit-testable.
 *
 * In local-agent IPC mode (`ELIZA_DESKTOP_LOCAL_AGENT_IPC=1`) the agent-child
 * spawn attaches a {@link LocalAgentStdioDispatcher} bound to the child's stdio
 * bridge via {@link setActiveLocalAgentDispatcher}. In default (loopback HTTP)
 * mode nothing registers a dispatcher and the renderer never addresses the IPC
 * api base, so the handler is never reached; if it is (misconfiguration — the
 * IPC api base was pushed without a live dispatcher) it throws loudly rather
 * than silently opening a socket the feature exists to remove.
 */

import type { LocalAgentDispatcher } from "./local-agent-request";

let activeDispatcher: LocalAgentDispatcher | null = null;

/** Register the dispatcher the agent child attached over its stdio bridge. */
export function setActiveLocalAgentDispatcher(
  dispatcher: LocalAgentDispatcher | null,
): void {
  activeDispatcher = dispatcher;
}

/** The active dispatcher, or `null` when the agent child is not IPC-connected. */
export function getActiveLocalAgentDispatcher(): LocalAgentDispatcher | null {
  return activeDispatcher;
}

/**
 * Resolve the active dispatcher or throw. The `localAgentRequest` handler uses
 * this so a request that arrives with no live IPC bridge fails observably.
 */
export function requireActiveLocalAgentDispatcher(): LocalAgentDispatcher {
  if (!activeDispatcher) {
    throw new Error(
      "localAgentRequest received but no local-agent IPC dispatcher is attached: the agent child is not running in local-agent IPC mode (ELIZA_DESKTOP_LOCAL_AGENT_IPC=1).",
    );
  }
  return activeDispatcher;
}
