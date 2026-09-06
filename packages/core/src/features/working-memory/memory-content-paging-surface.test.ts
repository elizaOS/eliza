/**
 * Pins the #25140 native content-paging surface at the AgentRuntime boundary
 * (deterministic — real AgentRuntime over hand-rolled adapters; no module
 * mocks). The runtime previously had NO passthrough for
 * `getMemoryContentPage`/`memoryContentPageCapability`, which left the
 * MESSAGE/ATTACHMENT paged-read paths unreachable in production even when the
 * SQL adapter declared the capability. These tests pin both directions:
 * absent on a non-paging adapter, forwarded (bound method + advertisement)
 * on a paging one.
 */

import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter.ts";
import { hasMemoryContentPageCapability } from "../../memory/content-segmentation.ts";
import { AgentRuntime } from "../../runtime.ts";
import type {
	Character,
	IDatabaseAdapter,
	MemoryContentPageParams,
	MemoryContentPageResult,
	UUID,
} from "../../types/index.ts";

/** Minimal adapter that declares the paging capability, for the forwarding
 * assertions. The adapter's real behavior is covered by plugin-sql's own
 * real-PGlite integration suites. */
class PageCapableAdapter extends InMemoryDatabaseAdapter {
	readonly memoryContentPageCapability = 1 as const;
	private readonly pages = new Map<string, MemoryContentPageResult>();
	setPage(memoryId: UUID, page: MemoryContentPageResult) {
		this.pages.set(memoryId, page);
	}
	async getMemoryContentPage(
		params: MemoryContentPageParams,
	): Promise<MemoryContentPageResult | null> {
		return this.pages.get(params.memoryId) ?? null;
	}
}

function makeRuntime(adapter: IDatabaseAdapter): AgentRuntime {
	const runtime = new AgentRuntime({
		character: { name: "paging-surface" } as Character,
	});
	runtime.registerDatabaseAdapter(adapter);
	return runtime;
}

describe("AgentRuntime memory-content paging surface (#25140)", () => {
	it("an adapter without the segment store leaves the runtime non-page-capable", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.init();
		const runtime = makeRuntime(adapter);

		expect(runtime.getMemoryContentPage).toBeUndefined();
		expect(runtime.memoryContentPageCapability).toBeUndefined();
		expect(hasMemoryContentPageCapability(runtime)).toBe(false);
	});

	it("forwards a paging adapter's method (bound to the adapter) and capability advertisement", async () => {
		const adapter = new PageCapableAdapter();
		await adapter.init();
		const runtime = makeRuntime(adapter);
		const memoryId = "00000000-0000-0000-0000-0000000000c1" as UUID;
		adapter.setPage(memoryId, {
			text: "page body",
			start: 0,
			end: 9,
			total: 9,
			sliceSha256: "0".repeat(64),
			sourceSha256: "1".repeat(64),
			revision: "seg:r",
			completeness: "complete",
		});

		expect(runtime.memoryContentPageCapability).toBe(1);
		expect(hasMemoryContentPageCapability(runtime)).toBe(true);
		expect(typeof runtime.getMemoryContentPage).toBe("function");

		const page = await runtime.getMemoryContentPage?.({
			memoryId,
			field: { kind: "content.text" },
			byteStart: 0,
		});
		expect(page?.text).toBe("page body");
		expect(page?.completeness).toBe("complete");
	});
});
