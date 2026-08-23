/**
 * Pins clipboard-persistence gating. The flag parser decides whether an
 * ATTACHMENT message asks for storage at all, so its accepted vocabulary is a
 * contract with model output rather than an implementation detail; the title
 * resolver has a four-step precedence chain; and both no-request and
 * empty-content paths must return a discriminated result before any service is
 * constructed. Pure functions plus two early returns — no service, no runtime
 * behaviour exercised.
 */
import { describe, expect, it } from "vitest";
import type { IAgentRuntime, Memory } from "../../types/index.ts";
import {
	maybeStoreTaskClipboardItem,
	resolveClipboardTitle,
	shouldAddToClipboard,
} from "./taskClipboardPersistence.ts";

function message(content: Record<string, unknown> = {}): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000001",
		entityId: "00000000-0000-0000-0000-000000000002",
		roomId: "00000000-0000-0000-0000-000000000003",
		content,
	} as unknown as Memory;
}

/** Never reached by the two early-return paths under test. */
const unusedRuntime = {} as IAgentRuntime;

const FLAG_KEYS = [
	"addToClipboard",
	"persistToClipboard",
	"saveToClipboard",
] as const;

describe("shouldAddToClipboard", () => {
	it("is false for a message with no flags", () => {
		expect(shouldAddToClipboard(message())).toBe(false);
	});

	it.each(FLAG_KEYS)("accepts boolean true on %s", (key) => {
		expect(shouldAddToClipboard(message({ [key]: true }))).toBe(true);
	});

	it.each(FLAG_KEYS)("accepts the string vocabulary on %s", (key) => {
		for (const value of ["true", "1", "yes", "y", "on"]) {
			expect(shouldAddToClipboard(message({ [key]: value }))).toBe(true);
		}
	});

	it("is case-insensitive and tolerates surrounding whitespace", () => {
		for (const value of ["TRUE", "True", "YES", "  on  ", "\tY\n"]) {
			expect(shouldAddToClipboard(message({ addToClipboard: value }))).toBe(
				true,
			);
		}
	});

	it("rejects negative and unrecognised strings", () => {
		for (const value of [
			"false",
			"0",
			"no",
			"n",
			"off",
			"",
			"  ",
			"maybe",
			"truthy",
		]) {
			expect(shouldAddToClipboard(message({ addToClipboard: value }))).toBe(
				false,
			);
		}
	});

	it("rejects non-boolean, non-string values", () => {
		for (const value of [1, 0, null, undefined, {}, [], () => true]) {
			expect(shouldAddToClipboard(message({ addToClipboard: value }))).toBe(
				false,
			);
		}
	});

	it("is true when any one flag is set", () => {
		expect(
			shouldAddToClipboard(
				message({ addToClipboard: false, saveToClipboard: "yes" }),
			),
		).toBe(true);
	});
});

describe("resolveClipboardTitle", () => {
	it("prefers clipboardTitle over title and over the fallback", () => {
		expect(
			resolveClipboardTitle(
				message({ clipboardTitle: "explicit", title: "generic" }),
				"fallback",
			),
		).toBe("explicit");
	});

	it("falls back to title, then to the supplied fallback", () => {
		expect(
			resolveClipboardTitle(message({ title: "generic" }), "fallback"),
		).toBe("generic");
		expect(resolveClipboardTitle(message(), "fallback")).toBe("fallback");
	});

	it("returns undefined when nothing usable is available", () => {
		expect(resolveClipboardTitle(message())).toBeUndefined();
		expect(resolveClipboardTitle(message(), "")).toBeUndefined();
		expect(resolveClipboardTitle(message(), "   ")).toBeUndefined();
	});

	it("trims the chosen title", () => {
		expect(
			resolveClipboardTitle(message({ clipboardTitle: "  padded  " })),
		).toBe("padded");
	});

	it("skips a blank candidate and keeps looking", () => {
		expect(
			resolveClipboardTitle(
				message({ clipboardTitle: "   ", title: "generic" }),
			),
		).toBe("generic");
	});

	it("ignores non-string candidates", () => {
		expect(
			resolveClipboardTitle(
				message({ clipboardTitle: 42, title: ["x"] }),
				"fallback",
			),
		).toBe("fallback");
	});

	it("preserves inner whitespace and unicode", () => {
		expect(
			resolveClipboardTitle(message({ clipboardTitle: "  a b  é \u{1f680} " })),
		).toBe("a b  é \u{1f680}");
	});
});

describe("maybeStoreTaskClipboardItem — early returns", () => {
	it("reports not-requested without touching a service", async () => {
		await expect(
			maybeStoreTaskClipboardItem(unusedRuntime, message(), {
				content: "anything",
			} as never),
		).resolves.toEqual({ requested: false, stored: false });
	});

	it("reports requested-but-unstored for blank content", async () => {
		for (const content of ["", "   ", "\n\t"]) {
			const result = await maybeStoreTaskClipboardItem(
				unusedRuntime,
				message({ addToClipboard: true }),
				{ content } as never,
			);
			expect(result.requested).toBe(true);
			expect(result.stored).toBe(false);
			expect((result as { reason: string }).reason.length).toBeGreaterThan(0);
		}
	});

	it("does not throw on either early-return path", async () => {
		await expect(
			maybeStoreTaskClipboardItem(unusedRuntime, message(), {
				content: "",
			} as never),
		).resolves.toBeDefined();
	});

	it("checks the request flag before the content", async () => {
		// Blank content without a flag is "not requested", not "no content".
		const result = await maybeStoreTaskClipboardItem(unusedRuntime, message(), {
			content: "",
		} as never);
		expect(result).toEqual({ requested: false, stored: false });
	});
});
