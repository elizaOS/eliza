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

export const uiContextProvider: Provider = {
	name: "UI_CONTEXT",
	description:
		"Eliza UI surface that sent the current message and the forced capability context for this turn.",
	position: -10,
	get: async (_runtime, message: Memory, state: State) => {
		const metadata = asRecord(message.content?.metadata);
		const uiView = asString(metadata?.uiView);
		const uiTab = asString(metadata?.uiTab);
		const routing = parseContextRoutingMetadata(
			metadata?.[CONTEXT_ROUTING_METADATA_KEY] ??
				state.values?.[CONTEXT_ROUTING_STATE_KEY],
		);
		const activeContexts = getActiveRoutingContexts(routing);

		if (!uiView && activeContexts.length === 0) {
			return { text: "", values: {}, data: {} };
		}

		const lines = [
			"# UI Context",
			`view: ${uiView ?? "chat"}`,
			uiTab ? `tab: ${uiTab}` : null,
			`active_contexts: ${activeContexts.join(", ") || "general"}`,
			"Use actions and providers that match this UI context first.",
		].filter((line): line is string => line !== null);

		return {
			text: lines.join("\n"),
			values: {
				uiView: uiView ?? "chat",
				uiTab: uiTab ?? "",
				uiContexts: activeContexts.join(", "),
			},
			data: {
				uiView,
				uiTab,
				activeContexts,
			},
		};
	},
};
