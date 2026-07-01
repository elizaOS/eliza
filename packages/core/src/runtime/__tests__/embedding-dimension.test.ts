import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../../runtime";
import { ModelType } from "../../types/model";

describe("AgentRuntime.ensureEmbeddingDimension", () => {
	it("skips dimension setup when the registered embedding provider probe fails", async () => {
		const warn = vi.fn();
		const ensureEmbeddingDimension = vi.fn();
		const runtime = {
			adapter: { ensureEmbeddingDimension },
			agentId: "00000000-0000-0000-0000-000000000001",
			getModel: vi.fn((type: string) =>
				type === ModelType.TEXT_EMBEDDING ? vi.fn() : undefined,
			),
			logger: { warn },
			useModel: vi.fn(async () => {
				throw new Error("Not Implemented");
			}),
		};

		await AgentRuntime.prototype.ensureEmbeddingDimension.call(runtime);

		expect(ensureEmbeddingDimension).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: runtime.agentId,
				error: "Not Implemented",
				src: "agent",
			}),
			"TEXT_EMBEDDING provider failed dimension probe, skipping embedding setup",
		);
	});
});