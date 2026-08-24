/**
 * Unit tests for agent skills action validators: validates service presence check.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { createAgentSkillsActionValidator } from "./validators.ts";

describe("agent-skills validators", () => {
	it("returns true when AGENT_SKILLS_SERVICE is registered on runtime", async () => {
		const validator = createAgentSkillsActionValidator();
		const runtime = {
			getService: (name: string) =>
				name === "AGENT_SKILLS_SERVICE" ? { listSkills: () => [] } : null,
		} as unknown as IAgentRuntime;

		const res = await validator(runtime, {} as any, {} as any);
		expect(res).toBe(true);
	});

	it("returns false when AGENT_SKILLS_SERVICE is missing or throws", async () => {
		const validator = createAgentSkillsActionValidator();
		const runtimeMissing = {
			getService: () => null,
		} as unknown as IAgentRuntime;

		expect(await validator(runtimeMissing, {} as any, {} as any)).toBe(false);

		const runtimeThrowing = {
			getService: () => {
				throw new Error("Service lookup failed");
			},
		} as unknown as IAgentRuntime;

		expect(await validator(runtimeThrowing, {} as any, {} as any)).toBe(false);
	});
});
