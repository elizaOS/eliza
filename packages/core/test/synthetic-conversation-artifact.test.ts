import { describe, expect, it } from "vitest";
import {
	isSyntheticConversationArtifactMemory,
	isSyntheticConversationArtifactText,
} from "../src/utils/synthetic-conversation-artifact.ts";

describe("isSyntheticConversationArtifactText", () => {
	it("does not flag a genuine request for a summary", () => {
		expect(
			isSyntheticConversationArtifactText(
				"Can you give me a conversation summary of what we discussed?",
			),
		).toBe(false);
	});

	it("does not flag a genuine instruction that names summary mode", () => {
		expect(
			isSyntheticConversationArtifactText(
				"Please switch to summary mode for the next answer.",
			),
		).toBe(false);
	});

	it("does not flag a genuine question that mentions the compactor", () => {
		expect(
			isSyntheticConversationArtifactText(
				"What does the compactor do with our old messages?",
			),
		).toBe(false);
	});

	it("still flags a summary that leads with the phrase", () => {
		expect(
			isSyntheticConversationArtifactText(
				"Conversation summary: we talked about the launch.",
			),
		).toBe(true);
	});

	it("still flags a summary phrase at the start of a later line", () => {
		expect(
			isSyntheticConversationArtifactText(
				"Notes from today\nConversation summary: we talked about the launch.",
			),
		).toBe(true);
	});

	it("still flags markers, headings, and compacted trajectories", () => {
		expect(
			isSyntheticConversationArtifactText(
				"[conversation summary] we talked about the launch.",
			),
		).toBe(true);
		expect(
			isSyntheticConversationArtifactText("# Conversation Summary\nWe talked."),
		).toBe(true);
		expect(
			isSyntheticConversationArtifactText(
				"Compacted prior planner trajectory steps follow.",
			),
		).toBe(true);
	});

	it("does not flag an ordinary genuine turn", () => {
		expect(
			isSyntheticConversationArtifactText("Hello, how are you today?"),
		).toBe(false);
	});
});

describe("isSyntheticConversationArtifactMemory", () => {
	it("does not flag a genuine memory whose text asks for a summary", () => {
		expect(
			isSyntheticConversationArtifactMemory({
				content: {
					text: "Can you give me a conversation summary?",
				},
				metadata: { source: "user" },
			} as never),
		).toBe(false);
	});

	it("still flags a memory with a synthetic source", () => {
		expect(
			isSyntheticConversationArtifactMemory({
				content: { text: "We talked about the launch." },
				metadata: { source: "compaction" },
			} as never),
		).toBe(true);
	});
});
