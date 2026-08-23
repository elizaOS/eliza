/**
 * Unit tests for interaction blocks neutral layout projection and plain-text fallback rendering.
 */

import { describe, expect, it } from "vitest";
import type { InteractionBlock } from "../../types/interactions.js";
import {
	buildInteractionUrlResolver,
	FORM_FREE_TEXT_INVITE,
	renderContentInteractionsAsPlainText,
	renderInteractionsAsPlainText,
	toNeutralLayout,
	toPlainTextFallback,
} from "./layout.js";

describe("messaging interactions layout", () => {
	it("projects choice blocks to neutral button layout with callback data", () => {
		const block: InteractionBlock = {
			kind: "choice",
			id: "choice-1",
			scope: "test",
			prompt: "Choose your favorite fruit",
			options: [
				{ label: "Apple", value: "apple" },
				{ label: "Banana", value: "banana" },
			],
			allowCustom: false,
		};

		const layout = toNeutralLayout(block, { maxButtonsPerRow: 2 });
		expect(layout.text).toBe("Choose your favorite fruit");
		expect(layout.rows).toHaveLength(1);
		expect(layout.rows[0].buttons).toHaveLength(2);
		expect(layout.rows[0].buttons?.[0].label).toBe("Apple");
		expect(layout.rows[0].buttons?.[0].callbackData).toBe("ia1:apple");
		expect(layout.needsFallback).toBe(false);
	});

	it("handles choice blocks with allowCustom requiring fallback", () => {
		const block: InteractionBlock = {
			kind: "choice",
			id: "choice-2",
			scope: "test",
			prompt: "Select or write your own",
			options: [{ label: "Opt1", value: "opt1" }],
			allowCustom: true,
		};

		const layout = toNeutralLayout(block);
		expect(layout.needsFallback).toBe(true);
	});

	it("renders secret blocks with url or requires fallback", () => {
		const blockWithUrl: InteractionBlock = {
			kind: "secret",
			id: "secret-1",
			reason: "API key needed",
			url: "https://example.com/oauth",
			secretKind: "oauth",
			provider: "github",
		};

		const layout = toNeutralLayout(blockWithUrl);
		expect(layout.text).toBe("API key needed");
		expect(layout.rows[0].buttons?.[0].label).toBe("Connect github");
		expect(layout.rows[0].buttons?.[0].url).toBe("https://example.com/oauth");
		expect(layout.needsFallback).toBe(false);

		const blockWithoutUrl: InteractionBlock = {
			kind: "secret",
			id: "secret-2",
			reason: "Secret key",
			secretKind: "secret",
		};
		const noUrlLayout = toNeutralLayout(blockWithoutUrl);
		expect(noUrlLayout.needsFallback).toBe(true);
	});

	it("formats plain text fallback for choice, form, and followups", () => {
		const choiceBlock: InteractionBlock = {
			kind: "choice",
			id: "choice-3",
			scope: "test",
			prompt: "Pick one",
			options: [
				{ label: "Red", value: "red" },
				{ label: "Blue", value: "blue" },
			],
		};
		const text = toPlainTextFallback(choiceBlock);
		expect(text).toContain("Pick one");
		expect(text).toContain("1. Red");
		expect(text).toContain("2. Blue");
		expect(text).toContain("Reply with a number.");

		const formBlock: InteractionBlock = {
			kind: "form",
			id: "form-1",
			title: "Survey",
			description: "Tell us your thoughts",
			fields: [],
		};
		const formText = toPlainTextFallback(formBlock);
		expect(formText).toContain("Survey");
		expect(formText).toContain(FORM_FREE_TEXT_INVITE);
	});

	it("renders interaction-bearing text and content as plain text", () => {
		const plainResult = renderInteractionsAsPlainText("Simple raw text");
		expect(plainResult.hadBlocks).toBe(false);
		expect(plainResult.text).toBe("Simple raw text");

		const { text, hadBlocks } = renderContentInteractionsAsPlainText({
			text: "Please answer the prompt below:",
			interactions: [
				{
					kind: "choice",
					id: "choice-4",
					scope: "test",
					prompt: "Confirm action",
					options: [{ label: "Yes", value: "yes" }],
				},
			],
		});

		expect(hadBlocks).toBe(true);
		expect(text).toContain("Please answer the prompt below:");
		expect(text).toContain("Confirm action");
		expect(text).toContain("1. Yes");
	});

	it("builds interaction URL resolvers for tasks and navigate chips", () => {
		const resolver = buildInteractionUrlResolver("https://eliza.app/");
		expect(resolver.resolveUrl).toBeDefined();
		expect(resolver.resolveNavigateUrl).toBeDefined();

		const taskBlock: InteractionBlock = {
			kind: "task",
			title: "Clean Database",
			threadId: "task-99",
		};
		expect(resolver.resolveUrl?.(taskBlock)).toBe(
			"https://eliza.app/orchestrator?taskId=task-99",
		);

		expect(resolver.resolveNavigateUrl?.("/dashboard")).toBe(
			"https://eliza.app/dashboard",
		);
		expect(resolver.resolveNavigateUrl?.("settings")).toBe(
			"https://eliza.app/?view=settings",
		);
	});
});
