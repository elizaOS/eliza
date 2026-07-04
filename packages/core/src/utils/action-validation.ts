/**
 * Decides whether an action is eligible this turn by testing that the action's
 * declared routing contexts overlap the routing contexts active for the current
 * message and state. Eligibility depends only on active routing contexts, not on
 * natural-language keyword matching.
 */
import type { AgentContext, Memory, State } from "../types/index.ts";
import {
	getActiveRoutingContextsForTurn,
	routingContextsOverlap,
} from "./context-routing.ts";

export interface ActionContextValidationOptions {
	contexts: readonly AgentContext[];
	/**
	 * Optional localized keyword-data KEYS (into the i18n keyword DB under
	 * `@elizaos/shared/.../keywords`). Forward-looking search metadata only;
	 * `hasActionContext` decides purely on active routing contexts and never
	 * matches raw natural-language keywords (which would be English-hostile).
	 */
	keywordKeys?: readonly string[];
}

export function hasActionContext(
	message: Memory,
	state: State | undefined,
	options: ActionContextValidationOptions,
): boolean {
	const activeContexts = getActiveRoutingContextsForTurn(state, message);
	return routingContextsOverlap(options.contexts, activeContexts);
}
