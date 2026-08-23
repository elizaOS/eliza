/**
 * Behavioural coverage for the ATTACHMENT → task-clipboard persistence bridge.
 *
 * The harness is real: every storing case drives the actual file-backed
 * TaskClipboardService against a per-test temp directory supplied through
 * `getSetting("CLIPBOARD_BASE_PATH")`, and the error case is produced by a real
 * filesystem failure (base path beneath a regular file), never by mocking the
 * module under test.
 */
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IAgentRuntime, Memory, UUID } from "../../types/index.ts";
import {
	maybeStoreTaskClipboardItem,
	resolveClipboardTitle,
	shouldAddToClipboard,
} from "./taskClipboardPersistence.ts";
import { createTaskClipboardService } from "./taskClipboardService.ts";

const entityId = "00000000-0000-0000-0000-0000000000a1" as UUID;
const roomId = "00000000-0000-0000-0000-0000000000b2" as UUID;

interface ReportedErrorCall {
	scope: string;
	error: unknown;
	context?: Record<string, unknown>;
}

function memoryWith(content: Memory["content"]): Memory {
	return { entityId, roomId, content };
}

function createRuntime(
	basePath: string,
	reported: ReportedErrorCall[],
): IAgentRuntime {
	return {
		getSetting: (key: string) =>
			key === "CLIPBOARD_BASE_PATH" ? basePath : undefined,
		reportError: (scope: string, error: unknown, context?) => {
			reported.push({ scope, error, context });
		},
	} as unknown as IAgentRuntime;
}

let basePath: string;

beforeEach(async () => {
	basePath = await mkdtemp(path.join(tmpdir(), "eliza-clipboard-persist-"));
});

afterEach(async () => {
	await rm(basePath, { recursive: true, force: true });
});

describe("shouldAddToClipboard flag detection", () => {
	it("returns false when no clipboard flag is present", () => {
		expect(shouldAddToClipboard(memoryWith({ text: "hello" }))).toBe(false);
	});

	it("accepts each of the three flags independently", () => {
		expect(shouldAddToClipboard(memoryWith({ addToClipboard: true }))).toBe(
			true,
		);
		expect(shouldAddToClipboard(memoryWith({ persistToClipboard: true }))).toBe(
			true,
		);
		expect(shouldAddToClipboard(memoryWith({ saveToClipboard: true }))).toBe(
			true,
		);
	});

	it("parses truthy strings case-insensitively with surrounding whitespace", () => {
		for (const value of ["true", "1", "YES", "Y", "  on  ", "On"]) {
			expect(
				shouldAddToClipboard(memoryWith({ addToClipboard: value })),
				`flag value: ${JSON.stringify(value)}`,
			).toBe(true);
		}
	});

	it("rejects non-truthy values including numeric and negating strings", () => {
		for (const value of [false, undefined, "", "false", "0", "no", "off", 1]) {
			expect(
				shouldAddToClipboard(memoryWith({ addToClipboard: value })),
				`flag value: ${JSON.stringify(value)}`,
			).toBe(false);
		}
	});
});

describe("resolveClipboardTitle precedence", () => {
	it("prefers clipboardTitle over title over fallbackTitle", () => {
		const message = memoryWith({
			clipboardTitle: "from clipboard title",
			title: "from content title",
		});
		expect(resolveClipboardTitle(message, "from fallback")).toBe(
			"from clipboard title",
		);
		expect(resolveClipboardTitle(memoryWith({ title: "content" }), "fb")).toBe(
			"content",
		);
		expect(resolveClipboardTitle(memoryWith({}), "fb")).toBe("fb");
	});

	it("trims the chosen title", () => {
		expect(
			resolveClipboardTitle(memoryWith({ clipboardTitle: "  padded  " })),
		).toBe("padded");
	});

	it("skips whitespace-only candidates and falls through the chain", () => {
		expect(
			resolveClipboardTitle(
				memoryWith({ clipboardTitle: "   ", title: "\n\t" }),
				"  fallback  ",
			),
		).toBe("fallback");
	});

	it("returns undefined when no candidate has usable text", () => {
		expect(resolveClipboardTitle(memoryWith({}), undefined)).toBeUndefined();
		expect(resolveClipboardTitle(memoryWith({}), "   ")).toBeUndefined();
	});
});

describe("maybeStoreTaskClipboardItem", () => {
	it("reports not-requested without touching the store when no flag is set", async () => {
		const reported: ReportedErrorCall[] = [];
		const runtime = createRuntime(basePath, reported);

		const result = await maybeStoreTaskClipboardItem(
			runtime,
			memoryWith({ text: "no flags here" }),
			{ content: "would-be payload" },
		);

		expect(result).toEqual({ requested: false, stored: false });
		const service = createTaskClipboardService(runtime, { basePath });
		expect(await service.listItems()).toEqual([]);
		expect(reported).toEqual([]);
	});

	it("refuses whitespace-only content with an explicit reason before any storage", async () => {
		const reported: ReportedErrorCall[] = [];
		const runtime = createRuntime(basePath, reported);

		const result = await maybeStoreTaskClipboardItem(
			runtime,
			memoryWith({ addToClipboard: "on" }),
			{ content: "   \n\t  " },
		);

		expect(result).toEqual({
			requested: true,
			stored: false,
			reason: "No stored content was available to save in the clipboard.",
		});
		const service = createTaskClipboardService(runtime, { basePath });
		expect(await service.listItems()).toEqual([]);
		expect(reported).toEqual([]);
	});

	it("stores through the real file-backed service with trimmed content", async () => {
		const runtime = createRuntime(basePath, []);

		const result = await maybeStoreTaskClipboardItem(
			runtime,
			memoryWith({ persistToClipboard: true }),
			{ content: "  saved body \n", sourceType: "attachment" },
		);

		if (!result.stored || !result.requested) {
			throw new Error(`expected storage to succeed: ${JSON.stringify(result)}`);
		}
		expect(result.replaced).toBe(false);
		expect(result.item.content).toBe("saved body");
		expect(result.item.title).toBe("Attachment");
		expect(result.item.sourceType).toBe("attachment");
		expect(result.snapshot.items).toHaveLength(1);

		const reread = createTaskClipboardService(runtime, { basePath });
		const persisted = await reread.getItem(result.item.id, entityId);
		expect(persisted?.content).toBe("saved body");
	});

	it("resolves the title from the message when the input carries none", async () => {
		const runtime = createRuntime(basePath, []);

		const result = await maybeStoreTaskClipboardItem(
			runtime,
			memoryWith({ saveToClipboard: true, clipboardTitle: "meeting notes" }),
			{ content: "body", sourceType: "file", sourceLabel: "notes.md" },
		);

		if (!result.stored) {
			throw new Error(`expected storage to succeed: ${JSON.stringify(result)}`);
		}
		expect(result.item.title).toBe("meeting notes");
	});

	it("lets input.title win over message-derived titles", async () => {
		const runtime = createRuntime(basePath, []);

		const result = await maybeStoreTaskClipboardItem(
			runtime,
			memoryWith({ addToClipboard: true, clipboardTitle: "message title" }),
			{ content: "body", title: "explicit title" },
		);

		if (!result.stored) {
			throw new Error(`expected storage to succeed: ${JSON.stringify(result)}`);
		}
		expect(result.item.title).toBe("explicit title");
	});

	it("uses the message title before fallbackTitle and sanitizes it", async () => {
		const runtime = createRuntime(basePath, []);

		const result = await maybeStoreTaskClipboardItem(
			runtime,
			memoryWith({ addToClipboard: true, title: "multi\nspace\ttitle" }),
			{ content: "body", fallbackTitle: "ignored" },
		);

		if (!result.stored) {
			throw new Error(`expected storage to succeed: ${JSON.stringify(result)}`);
		}
		expect(result.item.title).toBe("multi space title");
	});

	it("replaces the prior item for the same sourceType and sourceId", async () => {
		const runtime = createRuntime(basePath, []);
		const message = memoryWith({ addToClipboard: true });

		const first = await maybeStoreTaskClipboardItem(runtime, message, {
			content: "first version",
			sourceType: "attachment",
			sourceId: "att-1",
		});
		const second = await maybeStoreTaskClipboardItem(runtime, message, {
			content: "second version",
			sourceType: "attachment",
			sourceId: "att-1",
		});

		if (!first.stored || !second.stored) {
			throw new Error("expected both stores to succeed");
		}
		expect(second.replaced).toBe(true);
		expect(second.item.id).toBe(first.item.id);
		expect(second.item.createdAt).toBe(first.item.createdAt);
		expect(second.snapshot.items).toHaveLength(1);
		expect(second.snapshot.items[0]?.content).toBe("second version");

		const reread = createTaskClipboardService(runtime, { basePath });
		expect(await reread.listItems(entityId)).toHaveLength(1);
	});

	it("tolerates a non-string entityId by using the unscoped store", async () => {
		const runtime = createRuntime(basePath, []);
		const message = {
			entityId: 12345,
			roomId,
			content: { addToClipboard: true },
		} as unknown as Memory;

		const result = await maybeStoreTaskClipboardItem(runtime, message, {
			content: "unscoped body",
		});

		if (!result.stored) {
			throw new Error(`expected storage to succeed: ${JSON.stringify(result)}`);
		}
		const reread = createTaskClipboardService(runtime, { basePath });
		expect((await reread.getItem(result.item.id))?.content).toBe(
			"unscoped body",
		);
	});

	it("translates a real filesystem failure into stored:false and reports the error", async () => {
		const blocker = path.join(basePath, "blocker");
		await writeFile(blocker, "a regular file, not a directory");
		const blockedBase = path.join(blocker, "clipboard");
		const reported: ReportedErrorCall[] = [];
		const runtime = createRuntime(blockedBase, reported);

		const result = await maybeStoreTaskClipboardItem(
			runtime,
			memoryWith({ addToClipboard: true }),
			{ content: "doomed payload" },
		);

		if (!result.requested || result.stored !== false) {
			throw new Error(
				`expected an unstored failure: ${JSON.stringify(result)}`,
			);
		}
		expect(typeof result.reason).toBe("string");
		expect(result.reason.length).toBeGreaterThan(0);
		expect(reported).toHaveLength(1);
		expect(reported[0]?.scope).toBe("TaskClipboardPersistence.store");
		expect(reported[0]?.context).toEqual({ roomId });
	});

	it("keeps per-entity stores isolated between entity ids", async () => {
		const runtime = createRuntime(basePath, []);
		const otherEntityId = "00000000-0000-0000-0000-0000000000c3" as UUID;

		const first = await maybeStoreTaskClipboardItem(
			runtime,
			memoryWith({ addToClipboard: true }),
			{
				content: "for entity one",
			},
		);
		const second = await maybeStoreTaskClipboardItem(
			runtime,
			{ entityId: otherEntityId, roomId, content: { addToClipboard: true } },
			{ content: "for entity two" },
		);

		if (!first.stored || !second.stored) {
			throw new Error("expected both stores to succeed");
		}
		const reread = createTaskClipboardService(runtime, { basePath });
		expect(
			(await reread.listItems(entityId)).map((item) => item.content),
		).toEqual(["for entity one"]);
		expect(
			(await reread.listItems(otherEntityId)).map((item) => item.content),
		).toEqual(["for entity two"]);
	});

	it("creates the backing directory on demand inside the configured base path", async () => {
		const nested = path.join(basePath, "nested-base");
		const reported: ReportedErrorCall[] = [];
		const runtime = createRuntime(nested, reported);

		const result = await maybeStoreTaskClipboardItem(
			runtime,
			memoryWith({ addToClipboard: true }),
			{
				content: "bootstraps dirs",
			},
		);

		if (!result.stored) {
			throw new Error(`expected storage to succeed: ${JSON.stringify(result)}`);
		}
		const entries = await readdir(nested);
		expect(entries.length).toBeGreaterThan(0);
		expect(reported).toEqual([]);
	});
});
