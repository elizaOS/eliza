/**
 * Unit tests for TaskClipboardService: validates TASK_CLIPBOARD_MAX_ITEMS constant
 * and factory initialization.
 */
import { describe, expect, it } from "vitest";
import type { IAgentRuntime } from "../../types/index.ts";
import {
	createTaskClipboardService,
	TASK_CLIPBOARD_MAX_ITEMS,
} from "./taskClipboardService.ts";

describe("taskClipboardService", () => {
	it("exports TASK_CLIPBOARD_MAX_ITEMS as max safe integer", () => {
		expect(TASK_CLIPBOARD_MAX_ITEMS).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("creates task clipboard service instance with runtime", () => {
		const runtime = {} as IAgentRuntime;
		const service = createTaskClipboardService(runtime, {
			basePath: "/tmp/test",
		});
		expect(service).toBeDefined();
		expect(typeof service.addItem).toBe("function");
		expect(typeof service.getItem).toBe("function");
		expect(typeof service.removeItem).toBe("function");
	});
});
