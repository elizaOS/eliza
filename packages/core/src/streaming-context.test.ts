import { afterEach, describe, expect, it, vi } from "vitest";

type StreamingContextModule = typeof import("./streaming-context");

async function loadFreshCopy(): Promise<StreamingContextModule> {
	// A fresh module registry simulates a second bundled copy of core.
	vi.resetModules();
	return import("./streaming-context");
}

describe("streaming context across duplicated core copies", () => {
	afterEach(() => {
		vi.resetModules();
	});

	it("shares one context manager between copies", async () => {
		const first = await loadFreshCopy();
		const second = await loadFreshCopy();
		expect(second).not.toBe(first);
		expect(second.getStreamingContextManager()).toBe(
			first.getStreamingContextManager(),
		);

		await first.runWithStreamingContext({ messageId: "turn-1" }, async () => {
			await Promise.resolve();
			expect(second.getStreamingContext()?.messageId).toBe("turn-1");
		});
	});

	it("makes a manager override visible to every copy", async () => {
		const first = await loadFreshCopy();
		const second = await loadFreshCopy();
		const original = first.getStreamingContextManager();
		const override = {
			run: <T>(_context: unknown, fn: () => T): T => fn(),
			active: () => ({ messageId: "override" }),
		};
		try {
			second.setStreamingContextManager(override);
			expect(first.getStreamingContext()?.messageId).toBe("override");
		} finally {
			second.setStreamingContextManager(original);
		}
	});

	it("shares model stream chunk delivery depth between copies", async () => {
		const first = await loadFreshCopy();
		const second = await loadFreshCopy();
		await first.runInsideModelStreamChunkDelivery(async () => {
			await Promise.resolve();
			expect(second.getModelStreamChunkDeliveryDepth()).toBe(1);
		});
	});
});
