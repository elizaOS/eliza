/**
 * Verifies `LocalInferenceService.getInstalled()` surfaces and retries a
 * bundled-model bootstrap failure (#12271) instead of caching it as a silent
 * success. Deterministic: `registerBundledModels` and the registry read are
 * stubbed so the failure path is exercised without touching disk or a model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bootstrapMocks = vi.hoisted(() => ({
	registerBundledModels: vi.fn<() => Promise<number>>(),
	listInstalledModels: vi.fn(async () => []),
	error: vi.fn(),
}));

vi.mock("@elizaos/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@elizaos/core")>();
	return {
		...actual,
		logger: { ...actual.logger, error: bootstrapMocks.error },
	};
});

vi.mock("./bundled-models", () => ({
	registerBundledModels: bootstrapMocks.registerBundledModels,
}));

vi.mock("./registry", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./registry")>();
	return { ...actual, listInstalledModels: bootstrapMocks.listInstalledModels };
});

import { LocalInferenceService } from "./service";

describe("LocalInferenceService bundled-model bootstrap failure (#12271)", () => {
	beforeEach(() => {
		bootstrapMocks.registerBundledModels.mockReset();
		bootstrapMocks.listInstalledModels.mockReset();
		bootstrapMocks.listInstalledModels.mockResolvedValue([]);
		bootstrapMocks.error.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("surfaces a bootstrap failure via the logger and does not brick the read", async () => {
		bootstrapMocks.registerBundledModels.mockRejectedValueOnce(
			new Error("bundled registry write failed"),
		);
		const service = new LocalInferenceService();

		// The read degrades (returns the registry list) rather than throwing…
		await expect(service.getInstalled()).resolves.toEqual([]);
		// …but the failure is observable, not swallowed.
		expect(bootstrapMocks.error).toHaveBeenCalledTimes(1);
		const [, message] = bootstrapMocks.error.mock.calls[0] as [unknown, string];
		expect(message).toContain("bundled-model bootstrap failed");
	});

	it("retries the bootstrap on the next getInstalled() instead of caching the failure", async () => {
		bootstrapMocks.registerBundledModels
			.mockRejectedValueOnce(new Error("transient write failure"))
			.mockResolvedValueOnce(2);
		const service = new LocalInferenceService();

		await service.getInstalled();
		await service.getInstalled();

		// A cached-as-success swallow would call registerBundledModels once; the
		// retry-on-failure contract calls it again after the first rejection.
		expect(bootstrapMocks.registerBundledModels).toHaveBeenCalledTimes(2);
	});

	it("caches a successful bootstrap and runs it at most once", async () => {
		bootstrapMocks.registerBundledModels.mockResolvedValue(1);
		const service = new LocalInferenceService();

		await service.getInstalled();
		await service.getInstalled();

		expect(bootstrapMocks.registerBundledModels).toHaveBeenCalledTimes(1);
		expect(bootstrapMocks.error).not.toHaveBeenCalled();
	});
});
