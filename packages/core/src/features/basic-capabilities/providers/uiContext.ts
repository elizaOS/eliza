/**
 * UI_CONTEXT provider — surfaces which Eliza UI surface (view and tab) sent the
 * current message and the capability contexts forced active for this turn, so
 * the planner prefers actions and providers matching that context first. Stays
 * silent when there is neither a UI view nor an active routing context. Part of
 * the basic-capabilities bundle.
 */

import type { Memory, Provider, State } from "../../../types/index.ts";
import {
	CONTEXT_ROUTING_METADATA_KEY,
	CONTEXT_ROUTING_STATE_KEY,
	getActiveRoutingContexts,
	parseContextRoutingMetadata,
} from "../../../utils/context-routing.ts";
import { asRecord } from "../../../utils/type-guards.ts";

function asString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function asStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		const parsed = asString(entry);
		return parsed ? [parsed] : [];
	});
}

export const uiContextProvider: Provider = {
	name: "UI_CONTEXT",
	description:
		"Eliza UI surface that sent the current message and the forced capability context for this turn.",
	position: -10,
	contexts: ["general"],
	contextGate: { anyOf: ["general"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "USER" },

	get: async (_runtime, message: Memory, state: State) => {
		const metadata = asRecord(message.content.metadata);
		const uiView = asString(metadata?.uiView);
		const uiTab = asString(metadata?.uiTab);
		const uiViewPath = asString(metadata?.uiViewPath);
		const uiViewCapabilities = asStringList(metadata?.uiViewCapabilities);
		const uiViewActionNames = asStringList(metadata?.uiViewActionNames);
		const routing = parseContextRoutingMetadata(
			metadata?.[CONTEXT_ROUTING_METADATA_KEY] ??
				state.values[CONTEXT_ROUTING_STATE_KEY],
		);
		const activeContexts = getActiveRoutingContexts(routing);

		if (!uiView && activeContexts.length === 0) {
			return { text: "", values: {}, data: {} };
		}

		const lines = [
			"# UI Context",
			`view: ${uiView ?? "chat"}`,
			uiTab ? `tab: ${uiTab}` : null,
			uiViewPath ? `path: ${uiViewPath}` : null,
			uiViewCapabilities.length > 0
				? `view_capabilities: ${uiViewCapabilities.join(", ")}`
				: null,
			uiViewActionNames.length > 0
				? `view_actions: ${uiViewActionNames.join(", ")}`
				: null,
			`active_contexts: ${activeContexts.join(", ") || "general"}`,
			"Treat view_capabilities as available context, not as a request to invoke them.",
			"If the user asks which view is open or what can be done here, answer directly from this UI Context without calling a tool.",
			"For an actual operation, prefer the focused domain action (for example NOTES for note records or CALENDAR for events). Use VIEWS for navigation, layout, or an explicit declared UI capability that has no dedicated domain action. Never claim an operation happened unless its action succeeded.",
		].filter((line): line is string => line !== null);

		return {
			text: lines.join("\n"),
			values: {
				uiView: uiView ?? "chat",
				uiTab: uiTab ?? "",
				uiViewPath: uiViewPath ?? "",
				uiViewCapabilities: uiViewCapabilities.join(", "),
				uiViewActionNames: uiViewActionNames.join(", "),
				uiContexts: activeContexts.join(", "),
			},
			data: {
				uiView,
				uiTab,
				uiViewPath,
				uiViewCapabilities,
				uiViewActionNames,
				activeContexts,
			},
		};
	},
};
