import type { AgentContext, Memory, State } from "../types/index.ts";
import {
	getActiveRoutingContextsForTurn,
	routingContextsOverlap,
} from "./context-routing.ts";

export interface ActionContextValidationOptions {
	contexts: readonly AgentContext[];
	/** Search / i18n metadata; ignored by `hasActionContext` routing logic. */
	keywords?: readonly string[];
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
