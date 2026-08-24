/**
 * Unit tests for taskClipboardPersistence: verifies clipboard flag detection,
 * title resolution priority, and maybeStoreTaskClipboardItem handling.
 */
import { describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, Memory } from "../../types/index.ts";
import {
	maybeStoreTaskClipboardItem,
	resolveClipboardTitle,
	shouldAddToClipboard,
} from "./taskClipboardPersistence.ts";

describe("taskClipboardPersistence", () => {
	const baseMemory: Memory = {
		id: "mem-1" as any,
		roomId: "room-1" as any,
		entityId: "entity-1" as any,
		agentId: "agent-1" as any,
		content: { text: "hello" },
		createdAt: Date.now(),
	};

	describe("shouldAddToClipboard", () => {
		it("returns false when no clipboard flags are set", () => {
			expect(shouldAddToClipboard(baseMemory)).toBe(false);
		});

		it("returns true for boolean true flags", () => {
			expect(
				shouldAddToClipboard({
					...baseMemory,
					content: { text: "", addToClipboard: true },
				}),
			).toBe(true);
			expect(
				shouldAddToClipboard({
					...baseMemory,
					content: { text: "", persistToClipboard: true },
				}),
			).toBe(true);
			expect(
				shouldAddToClipboard({
					...baseMemory,
					content: { text: "", saveToClipboard: true },
				}),
			).toBe(true);
		});

		it("returns true for string truthy flags", () => {
			expect(
				shouldAddToClipboard({
					...baseMemory,
					content: { text: "", addToClipboard: "true" },
				}),
			).toBe(true);
			expect(
				shouldAddToClipboard({
					...baseMemory,
					content: { text: "", persistToClipboard: "yes" },
				}),
			).toBe(true);
			expect(
				shouldAddToClipboard({
					...baseMemory,
					content: { text: "", saveToClipboard: "1" },
				}),
			).toBe(true);
		});

		it("returns false for string falsy values", () => {
			expect(
				shouldAddToClipboard({
					...baseMemory,
					content: { text: "", addToClipboard: "false" },
				}),
			).toBe(false);
			expect(
				shouldAddToClipboard({
					...baseMemory,
					content: { text: "", persistToClipboard: "no" },
				}),
			).toBe(false);
		});
	});

	describe("resolveClipboardTitle", () => {
		it("prioritizes clipboardTitle over title and fallback", () => {
			const memory: Memory = {
				...baseMemory,
				content: {
					text: "",
					clipboardTitle: "Explicit Title",
					title: "Content Title",
				},
			};
			expect(resolveClipboardTitle(memory, "Fallback Title")).toBe(
				"Explicit Title",
			);
		});

		it("falls back to content.title when clipboardTitle is absent", () => {
			const memory: Memory = {
				...baseMemory,
				content: { text: "", title: "Content Title" },
			};
			expect(resolveClipboardTitle(memory, "Fallback Title")).toBe(
				"Content Title",
			);
		});

		it("falls back to fallbackTitle when content titles are absent", () => {
			expect(resolveClipboardTitle(baseMemory, "Fallback Title")).toBe(
				"Fallback Title",
			);
		});

		it("returns undefined when no valid titles exist", () => {
			expect(resolveClipboardTitle(baseMemory)).toBeUndefined();
			expect(resolveClipboardTitle(baseMemory, "   ")).toBeUndefined();
		});
	});

	describe("maybeStoreTaskClipboardItem", () => {
		it("returns requested: false when flag is not set", async () => {
			const runtime = {} as IAgentRuntime;
			const res = await maybeStoreTaskClipboardItem(runtime, baseMemory, {
				content: "sample content",
			});
			expect(res).toEqual({ requested: false, stored: false });
		});

		it("returns requested: true, stored: false when content is empty", async () => {
			const runtime = {} as IAgentRuntime;
			const memory: Memory = {
				...baseMemory,
				content: { text: "", addToClipboard: true },
			};
			const res = await maybeStoreTaskClipboardItem(runtime, memory, {
				content: "   ",
			});
			expect(res).toEqual({
				requested: true,
				stored: false,
				reason: "No stored content was available to save in the clipboard.",
			});
		});
	});
});
