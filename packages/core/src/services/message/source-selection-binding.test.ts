/** Real request binding and source validation; no model or effect mocks. */
import { describe, expect, it } from "vitest";
import {
	COMPLETION_CONTEXT_SCHEMA,
	completionContextSources,
	selectCompletionContext,
} from "../../runtime/completion-context";
import type { ContextObject } from "../../types/context-object";
import type { GenerateTextResult } from "../../types/model";
import { createSourceSelectionBinding } from "./source-selection-binding";
import { extractMessageHandlerRawParsed } from "./stage1-output";

function fixture(): ContextObject {
	return {
		id: "turn",
		metadata: { roomId: "room", messageId: "turn" },
		staticPrefix: { systemPrompt: { content: "Eliza", stable: true } },
		events: ["Keep all other notes.", "Unrelated completed request"].map(
			(content, i) => ({
				id: `history:${i}`,
				type: "segment",
				source: "prior-dialogue",
				segment: {
					id: `history:${i}`,
					label: "prior_message:user",
					content,
					stable: false,
				},
			}),
		),
	};
}
const schema = {
	type: "object",
	properties: { completionContext: COMPLETION_CONTEXT_SCHEMA },
};
function response(sourceSetId = "current_request", relevantSourceIds = ["h1"]) {
	return {
		text: "",
		toolCalls: [
			{
				id: "decision",
				name: "HANDLE_RESPONSE",
				arguments: {
					shouldRespond: "RESPOND",
					completionContext: {
						mode: "relevant_prior_dialogue",
						sourceSetId,
						complete: true,
						relevantSourceIds,
						constraintSourceIds: [],
						referentSourceIds: [],
						pendingIntentSourceIds: [],
					},
				},
			},
		],
	};
}
function bindingFor(context: ContextObject) {
	const binding = createSourceSelectionBinding(schema, context);
	if (!binding) throw new Error("Expected populated source binding");
	return binding;
}
function selected(context: ContextObject, raw: string | GenerateTextResult) {
	return selectCompletionContext({
		...context,
		metadata: {
			...context.metadata,
			completionContext: extractMessageHandlerRawParsed(raw)?.completionContext,
		},
	});
}
describe("native request source binding", () => {
	it("binds a native request reference without changing raw evidence or selection", () => {
		const context = fixture();
		const binding = bindingFor(context);
		const raw = response();
		const before = JSON.stringify(raw);
		const resolved = binding.resolve(raw);
		expect(selected(context, resolved).applied).toBe(true);
		expect(extractMessageHandlerRawParsed(resolved)?.completionContext).toEqual(
			{
				...(extractMessageHandlerRawParsed(raw)?.completionContext as object),
				sourceSetId: completionContextSources(context).sourceSetId,
			},
		);
		expect(JSON.stringify(raw)).toBe(before);
		expect(schema.properties.completionContext).toBe(COMPLETION_CONTEXT_SCHEMA);
	});
	it("keeps wire schemas identical across source sets while binding each response separately", () => {
		const first = fixture();
		const second = { ...fixture(), id: "next" };
		const a = bindingFor(first);
		const b = bindingFor(second);
		expect(a.parameters).toEqual(b.parameters);
		expect(selected(second, a.resolve(response())).applied).toBe(false);
		expect(selected(second, b.resolve(response())).applied).toBe(true);
	});
	it("captures dispatch identity before the source context changes", () => {
		const context = fixture();
		const binding = bindingFor(context);
		context.events[0] = { ...context.events[0], id: "replacement" };
		expect(selected(context, binding.resolve(response())).applied).toBe(false);
	});
	it("rejects cross-room reuse", () => {
		const context = fixture();
		const binding = bindingFor(context);
		const other = {
			...context,
			metadata: { ...context.metadata, roomId: "other-room" },
		};
		expect(selected(other, binding.resolve(response())).applied).toBe(false);
	});
	it("does not repair a stale real hash, unknown source, or incomplete selection", () => {
		const context = fixture();
		const binding = bindingFor(context);
		const stale = response("a".repeat(64));
		expect(binding.resolve(stale)).toEqual(stale);
		expect(selected(context, binding.resolve(stale)).applied).toBe(false);
		expect(
			selected(context, binding.resolve(response("current_request", ["h999"])))
				.applied,
		).toBe(false);
		const raw = response();
		const args = raw.toolCalls[0].arguments;
		args.completionContext.complete = false;
		expect(selected(context, binding.resolve(raw)).applied).toBe(false);
	});
	it("does not bind legacy JSON, read tools, missing identities, or empty history", () => {
		const context = fixture();
		const binding = bindingFor(context);
		const legacy = JSON.stringify(response().toolCalls[0].arguments);
		expect(binding.resolve(legacy)).toBe(legacy);
		const read = response();
		read.toolCalls[0].name = "READ_CONTEXT";
		expect(binding.resolve(read)).toEqual(read);
		expect(binding.resolve(response(""))).toEqual(response(""));
		expect(
			createSourceSelectionBinding(schema, { ...context, events: [] }),
		).toBeUndefined();
	});
});
