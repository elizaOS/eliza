/** Verifies lossless receipt selection/restoration across the combined runtime. */
import { describe, expect, it } from "vitest";
import { renderMessageHandlerModelInput } from "../../../../plugins/plugin-assistant/src/services/message/stage1-input";
import type { CompletionContextSelection } from "../types/components";
import type { ContextObject } from "../types/context-object";
import {
	completionContextSources,
	selectCompletionContext,
} from "./completion-context";

function historyContext(): ContextObject {
	return {
		id: "test-current",
		metadata: { roomId: "room-owner", messageId: "current" },
		events: Array.from({ length: 5 }, (_, index) => ({
			id: `history:message-${index + 1}`,
			type: "segment" as const,
			source: "prior-dialogue",
			segment: {
				id: `history:message-${index + 1}`,
				label: "prior_message:user",
				stable: false,
				content: `Original request ${index + 1}`,
				metadata: { roomId: "room-owner", entityId: "owner" },
			},
		})),
	};
}
function selection(context: ContextObject): CompletionContextSelection {
	return {
		mode: "selected",
		complete: true,
		sourceSetId: completionContextSources(context).sourceSetId,
		relevantSourceIds: ["h2"],
		constraintSourceIds: ["h1", "h4"],
		referentSourceIds: ["h2"],
		pendingIntentSourceIds: ["h5"],
	};
}
function withSelection(
	context: ContextObject,
	selected = selection(context),
): ContextObject {
	return {
		...context,
		metadata: { ...context.metadata, completionContext: selected as never },
	};
}

describe("source-bound historical navigation", () => {
	function fixture() {
		const context = historyContext();
		context.events.push({
			id: "navigation:old",
			type: "segment",
			source: "message-service",
			segment: {
				id: "navigation:old",
				label: "runtime:historical_navigation",
				stable: false,
				content: JSON.stringify({
					requestSourceEventId: "history:message-3",
					navigation: [{ success: true, receipt: "EXACT_NAVIGATION_RECEIPT" }],
				}),
			},
		});
		return context;
	}
	it("omits only receipts bound to omitted originals and restores them with the request", () => {
		const original = fixture();
		const before = JSON.stringify(original);
		expect(
			JSON.stringify(selectCompletionContext(withSelection(original)).context),
		).not.toContain("EXACT_NAVIGATION_RECEIPT");
		const selected = selection(original);
		selected.relevantSourceIds.push("h3");
		expect(
			JSON.stringify(
				selectCompletionContext(withSelection(original, selected)).context,
			),
		).toContain("EXACT_NAVIGATION_RECEIPT");
		expect(JSON.stringify(selectCompletionContext(original).context)).toContain(
			"EXACT_NAVIGATION_RECEIPT",
		);
		expect(JSON.stringify(original)).toBe(before);
	});
	it("invalidates selection when a bound receipt changes", () => {
		const original = fixture();
		const selected = selection(original);
		const event = original.events.at(-1);
		if (event?.type !== "segment") throw new Error("missing receipt");
		event.segment.content = event.segment.content.replace(
			"EXACT_NAVIGATION_RECEIPT",
			"CHANGED_RECEIPT",
		);
		expect(
			selectCompletionContext(withSelection(original, selected)).applied,
		).toBe(false);
	});
	it("keeps unbound receipt evidence instead of silently dropping it", () => {
		const original = fixture();
		const event = original.events.at(-1);
		if (event?.type !== "segment") throw new Error("missing receipt");
		event.segment.content = event.segment.content.replace(
			"history:message-3",
			"unknown-request",
		);
		expect(
			JSON.stringify(selectCompletionContext(withSelection(original)).context),
		).toContain("EXACT_NAVIGATION_RECEIPT");
	});
	it("keeps exact receipts in the full-history reply handler despite deferred-read hints", () => {
		const context = fixture();
		const history = {
			sourceSetId: completionContextSources(context).sourceSetId,
			scope: {
				agentId: "agent",
				roomId: "room-owner",
				entityId: "owner",
				roles: ["OWNER"],
			},
			visibleEventIds: new Set(["history:message-1", "history:message-4"]),
			loadedSourceIds: new Set<string>(),
		};
		const render = () =>
			JSON.stringify(
				renderMessageHandlerModelInput(
					{ character: { name: "Eliza" } },
					context,
					[],
					{ directMessage: true, history },
				).messages,
			);
		expect(render()).toContain("EXACT_NAVIGATION_RECEIPT");
		history.loadedSourceIds.add("h3");
		expect(render()).toContain("EXACT_NAVIGATION_RECEIPT");
	});
});
