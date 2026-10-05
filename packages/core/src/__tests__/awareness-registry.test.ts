import { describe, expect, it, vi } from "vitest";
import { AwarenessRegistry } from "../awareness";
import type { IAgentRuntime } from "../types/runtime";

function runtime(agentId: string): IAgentRuntime {
	return { agentId, reportError: vi.fn() } as unknown as IAgentRuntime;
}

describe("awareness contributor lifecycle", () => {
	it("scopes cached summaries to each runtime", async () => {
		const registry = new AwarenessRegistry();
		const summary = vi.fn(async (owner: IAgentRuntime) => owner.agentId);
		registry.register({ id: "identity", position: 0, summary, trusted: true });
		const first = runtime("first");
		const second = runtime("second");
		expect(await registry.composeSummary(first)).toContain("first");
		expect(await registry.composeSummary(second)).toContain("second");
		await registry.composeSummary(first);
		expect(summary).toHaveBeenCalledTimes(2);
	});
	it("retains unavailable markers and reports contributor failures", async () => {
		const registry = new AwarenessRegistry();
		const owner = runtime("owner");
		const cause = new Error("failed");
		registry.register({
			id: "broken",
			position: 0,
			summary: async () => {
				throw cause;
			},
			detail: async () => {
				throw cause;
			},
		});
		expect(await registry.composeSummary(owner)).toContain(
			"[broken: unavailable]",
		);
		expect(await registry.getDetail(owner, "broken", "full")).toBe(
			"[broken: unavailable]",
		);
		expect(owner.reportError).toHaveBeenCalledWith(
			"AwarenessRegistry.summary",
			cause,
			{ contributorId: "broken" },
		);
		expect(owner.reportError).toHaveBeenCalledWith(
			"AwarenessRegistry.detail",
			cause,
			{ contributorId: "broken" },
		);
	});
	it("does not restore invalidated cache entries from in-flight work", async () => {
		const registry = new AwarenessRegistry();
		let complete!: (value: string) => void;
		const summary = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<string>((resolve) => {
						complete = resolve;
					}),
			)
			.mockResolvedValue("fresh");
		registry.register({
			id: "changing",
			position: 0,
			summary,
			invalidateOn: ["config-changed"],
		});
		const owner = runtime("owner");
		const pending = registry.composeSummary(owner);
		registry.invalidate("config-changed");
		complete("old");
		await pending;
		expect(await registry.composeSummary(owner)).toContain("fresh");
	});
});
