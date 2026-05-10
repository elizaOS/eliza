import { describe, expect, it } from "vitest";
import type { IAgentRuntime } from "../../types";
import { TrajectoriesService } from "./TrajectoriesService";

function createRuntimeWithoutSql(): IAgentRuntime {
	return {
		adapter: { db: {} },
		getService: () => null,
		getServicesByType: () => [],
	} as unknown as IAgentRuntime;
}

describe("TrajectoriesService", () => {
	it("disables SQL-backed capture when the runtime adapter has no SQL executor", async () => {
		const service = await TrajectoriesService.start(createRuntimeWithoutSql());

		expect((service as TrajectoriesService).isEnabled()).toBe(false);

		await service.stop();
	});
});
