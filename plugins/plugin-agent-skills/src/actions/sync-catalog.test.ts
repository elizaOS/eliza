/** Verifies catalog-sync failures reach the manual action as explicit unsuccessful results. */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { syncCatalogAction } from "./sync-catalog";

describe("SKILL sync failure reporting", () => {
	it("does not report pagination anomalies as successful syncs", async () => {
		const paginationError = new Error(
			"Catalog pagination repeated cursor repeated-token",
		);
		const runtime = {
			getService: vi.fn(() => ({
				syncCatalog: vi.fn().mockRejectedValue(paginationError),
			})),
			logger: { info: vi.fn() },
		} as unknown as IAgentRuntime;
		const callback = vi.fn();

		const result = await syncCatalogAction.handler(
			runtime,
			{} as Memory,
			undefined,
			undefined,
			callback,
		);

		expect(result.success).toBe(false);
		expect(result.error).toBe(paginationError);
		expect(callback).toHaveBeenCalledWith({
			text: "Error syncing catalog: Catalog pagination repeated cursor repeated-token",
		});
		expect(callback.mock.calls[0]?.[0]?.text).not.toContain(
			"synced successfully",
		);
	});
});
