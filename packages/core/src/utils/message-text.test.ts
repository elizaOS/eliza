/**
 * Tests for `getUserMessageText`, covering that a connector's current-turn text
 * wins over the rendered channel envelope stored on the message content, and
 * for `stripAugmentationForPersistence`, which keeps the model-facing document
 * augmentation envelope out of persisted / echoed user memories.
 */
import { describe, expect, it } from "vitest";
import type { Memory } from "../types/memory";
import {
	getUserMessageText,
	hasDocumentAugmentationEnvelope,
	stripAugmentationForPersistence,
} from "./message-text";

describe("getUserMessageText", () => {
	it("prefers connector-provided current-turn text over rendered envelopes", () => {
		const message = {
			content: {
				text: '[Discord #general] @ada: Can you tell me what elizaOS is?\n(in reply to @agent: "The Bitcoin price is ...")',
				currentMessageText: "Can you tell me what elizaOS is?",
			},
		} as unknown as Memory;

		expect(getUserMessageText(message)).toBe(
			"Can you tell me what elizaOS is?",
		);
	});
});

// The exact model-facing wrapper that chat-augmentation.ts assembles around a
// user's text so retrieved documents reach the LLM. This is what leaked into
// the user's own chat bubble as raw XML (device screenshot, 2026-07-06).
function augmentedText(userText: string): string {
	return [
		"Answer the user request using the contextual documents below as the source of truth when they contain the answer.",
		"If the answer appears verbatim in the contextual documents, repeat it exactly.",
		"Do not ask follow-up questions or invoke tools/actions when the contextual documents already answer the request.",
		"",
		"<contextual_documents>",
		'<source title="notes.md" similarity="0.412">',
		"some retrieved snippet",
		"</source>",
		"</contextual_documents>",
		"",
		"<user_request>",
		userText,
		"</user_request>",
	].join("\n");
}

describe("stripAugmentationForPersistence", () => {
	it("unwraps the document augmentation envelope so persisted text is what the user typed", () => {
		const userText = "just fixing eliza app for demo";
		const message = {
			id: "m1",
			content: { text: augmentedText(userText), source: "client_chat" },
		} as unknown as Memory;

		const persisted = stripAugmentationForPersistence(message);

		// The stored/echoed text is the clean user message, no XML wrapper.
		expect(persisted.content.text).toBe(userText);
		expect(persisted.content.text).not.toContain("<user_request>");
		expect(persisted.content.text).not.toContain("<contextual_documents>");
		// Other content fields survive the copy.
		expect((persisted.content as { source?: string }).source).toBe(
			"client_chat",
		);
	});

	it("does not mutate the in-flight message (LLM turn keeps its wrap)", () => {
		const wrapped = augmentedText("hello there");
		const message = {
			content: { text: wrapped },
		} as unknown as Memory;

		const persisted = stripAugmentationForPersistence(message);

		expect(persisted).not.toBe(message);
		expect(message.content.text).toBe(wrapped);
		expect(persisted.content.text).toBe("hello there");
	});

	it("is a no-op passthrough for ordinary unwrapped user messages", () => {
		const message = {
			content: { text: "what is the weather today?" },
		} as unknown as Memory;

		const persisted = stripAugmentationForPersistence(message);

		// Same reference back: hot path pays nothing for the common case.
		expect(persisted).toBe(message);
	});

	it("leaves lookalike text that lacks the augmentation preamble untouched", () => {
		// A user genuinely typing <user_request> tags must NOT be unwrapped.
		const text = "why does <user_request>foo</user_request> show up in logs?";
		const message = { content: { text } } as unknown as Memory;

		const persisted = stripAugmentationForPersistence(message);

		expect(persisted).toBe(message);
		expect(persisted.content.text).toBe(text);
	});

	it("detects the envelope via hasDocumentAugmentationEnvelope", () => {
		expect(hasDocumentAugmentationEnvelope(augmentedText("hi"))).toBe(true);
		expect(hasDocumentAugmentationEnvelope("plain user text")).toBe(false);
		expect(hasDocumentAugmentationEnvelope(undefined)).toBe(false);
	});
});
