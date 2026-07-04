/**
 * Contract test pinning AgentSkillsService.serviceType to the exported
 * AGENT_SKILLS_SERVICE_TYPE constant so registration and lookup stay in sync.
 */

import { describe, expect, it } from "vitest";
import { AGENT_SKILLS_SERVICE_TYPE, AgentSkillsService } from "./skills";

describe("AgentSkillsService contract", () => {
	it("uses the exported service-type contract", () => {
		expect(AgentSkillsService.serviceType).toBe(AGENT_SKILLS_SERVICE_TYPE);
	});
});

