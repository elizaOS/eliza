/**
 * Behavioral coverage for the ATTACHMENT → task-clipboard persistence bridge:
 * the clipboard-request flag parsing (boolean and string truthy forms), the
 * display-title resolution precedence, and the discriminated store result
 * (including the empty-content and service-failure paths that must never
 * throw).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	maybeStoreTaskClipboardItem,
	resolveClipboardTitle,
	shouldAddToClipboard,
} from "./taskClipboardPersistence.ts";

const { createTaskClipboardService } = await import(
	"./taskClipboardService.ts"
);

vi.mock("./taskClipboardService.ts", () => ({
	createTaskClipboardService: vi.fn(),
}));

const mockCreate = vi.mocked(createTaskClipboardService);

function message(
	content: Record<string, unknown>,
): Parameters<typeof shouldAddToClipboard>[0] {
	return {
		content,
		roomId: "room-1",
		entityId: "entity-1",
		userId: "user-1",
		agentId: "agent-1",
	} as never;
}

describe("shouldAddToClipboard", () => {
	it("accepts a literal true on any of the three clipboard flags", () => {
		expect(shouldAddToClipboard(message({ addToClipboard: true }))).toBe(true);
		expect(shouldAddToClipboard(message({ persistToClipboard: true }))).toBe(
			true,
		);
		expect(shouldAddToClipboard(message({ saveToClipboard: true }))).toBe(true);
	});

	it("accepts string truthy flag values case-insensitively", () => {
		for (const flag of [
			"addToClipboard",
			"persistToClipboard",
			"saveToClipboard",
		]) {
			for (const value of ["true", "1", "yes", "y", "on", "TRUE", "Yes"]) {
				expect(shouldAddToClipboard(message({ [flag]: value }))).toBe(true);
			}
		}
	});

	it("rejects falsy, numeric, and unknown flag values", () => {
		expect(shouldAddToClipboard(message({ addToClipboard: false }))).toBe(
			false,
		);
		expect(shouldAddToClipboard(message({ addToClipboard: 1 }))).toBe(false);
		expect(shouldAddToClipboard(message({ addToClipboard: "off" }))).toBe(
			false,
		);
		expect(shouldAddToClipboard(message({}))).toBe(false);
		expect(shouldAddToClipboard(message({ persistToClipboard: "  " }))).toBe(
			false,
		);
	});
});

describe("resolveClipboardTitle", () => {
	it("prefers the explicit clipboard title over the generic title", () => {
		expect(
			resolveClipboardTitle(
				message({ clipboardTitle: "  Explicit  ", title: "Generic" }),
			),
		).toBe("Explicit");
	});

	it("falls back to the message title, then the caller fallback", () => {
		expect(resolveClipboardTitle(message({ title: "  Msg Title " }))).toBe(
			"Msg Title",
		);
		expect(resolveClipboardTitle(message({}), "Fallback Title")).toBe(
			"Fallback Title",
		);
	});

	it("returns undefined when every candidate is blank", () => {
		expect(
			resolveClipboardTitle(message({ clipboardTitle: "  " }), "   "),
		).toBeUndefined();
		expect(resolveClipboardTitle(message({}))).toBeUndefined();
	});
});

describe("maybeStoreTaskClipboardItem", () => {
	const fakeRuntime = {
		reportError: vi.fn(),
	} as never;

	beforeEach(() => {
		mockCreate.mockReset();
		fakeRuntime.reportError.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("short-circuits with requested:false when no clipboard flag is set", async () => {
		const result = await maybeStoreTaskClipboardItem(fakeRuntime, message({}), {
			content: "some text",
		} as never);
		expect(result).toEqual({ requested: false, stored: false });
		expect(mockCreate).not.toHaveBeenCalled();
	});

	it("returns an explicit unstored reason for empty content", async () => {
		const result = await maybeStoreTaskClipboardItem(
			fakeRuntime,
			message({ addToClipboard: true }),
			{ content: "   " } as never,
		);
		expect(result).toEqual({
			requested: true,
			stored: false,
			reason: "No stored content was available to save in the clipboard.",
		});
		expect(mockCreate).not.toHaveBeenCalled();
	});

	it("stores the trimmed content and reports the service snapshot", async () => {
		const item = { id: "item-1", title: "t", content: "payload" } as never;
		const snapshot = { items: [item] } as never;
		mockCreate.mockReturnValue({
			addItem: vi.fn().mockResolvedValue({ item, replaced: false, snapshot }),
		} as never);

		const result = await maybeStoreTaskClipboardItem(
			fakeRuntime,
			message({ addToClipboard: true }),
			{ content: "  payload  " } as never,
		);

		expect(result).toEqual({
			requested: true,
			stored: true,
			replaced: false,
			item,
			snapshot,
		});
		const addItem =
			mockCreate.mock.calls[0] &&
			(
				mockCreate.mock.results[0].value as {
					addItem: (input: unknown) => unknown;
				}
			).addItem;
		expect(addItem).toHaveBeenCalledWith(
			expect.objectContaining({ content: "payload" }),
			"entity-1",
		);
	});

	it("translates a service failure into an unstored result and reports it", async () => {
		mockCreate.mockReturnValue({
			addItem: vi.fn().mockRejectedValue(new Error("disk full")),
		} as never);

		const result = await maybeStoreTaskClipboardItem(
			fakeRuntime,
			message({ saveToClipboard: true }),
			{ content: "payload" } as never,
		);

		expect(result).toEqual({
			requested: true,
			stored: false,
			reason: "disk full",
		});
		expect(fakeRuntime.reportError).toHaveBeenCalledWith(
			"TaskClipboardPersistence.store",
			expect.any(Error),
			{ roomId: "room-1" },
		);
	});
});
