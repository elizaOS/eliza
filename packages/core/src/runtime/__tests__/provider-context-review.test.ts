import { describe, expect, it } from "vitest";
import type {
	ContextObject,
	ContextProviderEvent,
} from "../../types/context-object";
import {
	projectDeferredProviders,
	providerReviewSources,
} from "../provider-context";

function fixture(): ContextObject {
	const sources = [
		{
			id: "recalled1",
			text: "user: Preserve both  spaces and Ω. ".repeat(30),
			metadata: { recordId: "original", roomId: "room-a", entityId: "user" },
		},
		{
			id: "recalled2",
			text: "assistant: Unrelated earlier answer. ".repeat(30),
			metadata: { recordId: "reply", roomId: "room-a", entityId: "agent" },
		},
	];
	return {
		id: "turn",
		metadata: {
			roomId: "current",
			messageId: "request",
			providerDiscoveryEnabled: true,
		},
		events: [
			{
				id: "recall",
				type: "provider",
				name: "RECALL",
				text: sources.map((s) => `[${s.id}]\n${s.text}`).join("\n"),
				reviewableSources: {
					notice: "Partial: some sources withheld by access policy.",
					sources,
				},
			},
			{
				id: "other",
				type: "provider",
				name: "OTHER",
				text: "Always keep this policy.",
			},
		],
	};
}
function select(context: ContextObject, keep = ["recalled1"]) {
	context.metadata!.providerReview = {
		sourceSetId: providerReviewSources(context)!.sourceSetId,
		complete: true,
		keep,
	};
}
describe("reviewed provider sources", () => {
	it("projects exact selected text and access notice without mutating originals", () => {
		const context = fixture();
		select(context);
		const before = structuredClone(context);
		const result = projectDeferredProviders(context);
		const text = (result.context.events[0] as ContextProviderEvent).text!;
		expect(result.available).toEqual(["RECALL"]);
		expect(text).toContain("both  spaces and Ω");
		expect(text).not.toContain("Unrelated earlier answer");
		expect(text).toContain("withheld by access policy");
		expect(result.context.events[1]).toEqual(context.events[1]);
		expect(context).toEqual(before);
	});
	it.each([
		"missing",
		"incomplete",
		"unknown",
		"stale",
		"author",
		"room",
		"body",
		"turn",
		"restored",
	])("keeps full evidence for %s review", (mode) => {
		const context = fixture();
		select(context);
		const selection = context.metadata!.providerReview as {
			complete: boolean;
			keep: string[];
			sourceSetId: string;
		};
		const source = (context.events[0] as ContextProviderEvent)
			.reviewableSources!.sources[0];
		if (mode === "missing") delete context.metadata!.providerReview;
		if (mode === "incomplete") selection.complete = false;
		if (mode === "unknown") selection.keep = ["h1"];
		if (mode === "stale") selection.sourceSetId = "other";
		if (mode === "author") source.metadata.entityId = "other-user";
		if (mode === "room") source.metadata.roomId = "other-room";
		if (mode === "body") source.text += "New correction.";
		if (mode === "turn") context.metadata!.messageId = "next-request";
		if (mode === "restored")
			context.metadata!.loadedContextProviders = ["RECALL"];
		expect(projectDeferredProviders(context).context.events).toEqual(
			context.events,
		);
	});
	it("does not certify discovery-only or duplicate-ID sources", () => {
		const context = fixture();
		const event = context.events[0] as ContextProviderEvent;
		event.discoveryText = "Available to retrieve";
		expect(providerReviewSources(context)).toBeUndefined();
		delete event.discoveryText;
		event.reviewableSources!.sources[1].id = "recalled1";
		expect(providerReviewSources(context)).toBeUndefined();
	});
	it("materializes a selected repeated occurrence with its exact original body", () => {
		const context = fixture();
		const event = context.events[0] as ContextProviderEvent;
		const sources = event.reviewableSources?.sources;
		if (!sources) throw new Error("missing fixture sources");
		sources[1].text = sources[0].text;
		event.text =
			`[recalled1]\n${sources[0].text}\n[recalled2; same_text_as=recalled1]\n` +
			"Other body. ".repeat(100);
		select(context, ["recalled2"]);
		const text = (
			projectDeferredProviders(context).context
				.events[0] as ContextProviderEvent
		).text;
		expect(text).toContain(`[recalled2]\n${sources[0].text}`);
		expect(text).not.toContain("same_text_as");
	});
});
