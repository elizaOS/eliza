import { describe, expect, it } from "vitest";
import {
	isSyntheticConversationArtifactMemory,
	isSyntheticConversationArtifactText,
} from "./synthetic-conversation-artifact.ts";

describe("isSyntheticConversationArtifactText", () => {
	it("detects summary markers", () => {
		expect(
			isSyntheticConversationArtifactText("[conversation summary]..."),
		).toBe(true);
		expect(
			isSyntheticConversationArtifactText("[system hybrid-ledger]..."),
		).toBe(true);
		expect(isSyntheticConversationArtifactText("[system state]...")).toBe(true);
	});

	it("detects phrasing markers", () => {
		expect(
			isSyntheticConversationArtifactText(
				"compacted prior planner trajectory steps...",
			),
		).toBe(true);
		expect(isSyntheticConversationArtifactText("# Conversation Summary")).toBe(
			true,
		);
		expect(
			isSyntheticConversationArtifactText("the compactor ran in summary mode"),
		).toBe(true);
	});

	it("rejects genuine turns", () => {
		expect(isSyntheticConversationArtifactText("hello there")).toBe(false);
		expect(isSyntheticConversationArtifactText("")).toBe(false);
		expect(
			isSyntheticConversationArtifactText("let me summarize the code"),
		).toBe(false);
	});
});

describe("isSyntheticConversationArtifactMemory", () => {
	it("detects synthetic source metadata", () => {
		const memory = {
			content: { text: "hi" },
			metadata: { source: "compactor" },
		} as never;
		expect(isSyntheticConversationArtifactMemory(memory)).toBe(true);
	});

	it("detects synthetic tags", () => {
		const memory = {
			content: { text: "hi" },
			metadata: { tags: ["summary"] },
		} as never;
		expect(isSyntheticConversationArtifactMemory(memory)).toBe(true);
	});

	it("detects via the text path", () => {
		const memory = {
			content: { text: "[conversation summary]" },
			metadata: {},
		} as never;
		expect(isSyntheticConversationArtifactMemory(memory)).toBe(true);
	});

	it("rejects genuine memories", () => {
		const memory = {
			content: { text: "hi" },
			metadata: { source: "user" },
		} as never;
		expect(isSyntheticConversationArtifactMemory(memory)).toBe(false);
	});
});
