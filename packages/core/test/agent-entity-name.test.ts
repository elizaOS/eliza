/** The agent's own entity name follows its character name, through
 * `updateAgent` and at initialize, on the real initialized kernel fixture with
 * in-memory SQLite persistence. Prompts label speakers with `names[0]`. */

import { stringToUuid } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { createInitializedRuntime } from "./initialized-runtime";

const AGENT_ID = stringToUuid("agent-entity-name-test");

describe("agent entity name", () => {
	it("moves a renamed character's name to the front of the agent entity", async () => {
		const runtime = await createInitializedRuntime({
			character: { id: AGENT_ID, name: "Eliza", bio: "test" },
		});

		await runtime.updateAgent(runtime.agentId, { name: "Nova" });

		const [entity] = await runtime.getEntitiesByIds([runtime.agentId]);
		expect(entity?.names).toEqual(["Nova", "Eliza"]);
	});

	it("repairs an entity left with the previous name when the agent starts", async () => {
		const first = await createInitializedRuntime({
			character: { id: AGENT_ID, name: "Eliza", bio: "test" },
		});
		const second = await createInitializedRuntime({
			character: { id: AGENT_ID, name: "Nova", bio: "test" },
			adapter: first.adapter,
		});

		const [entity] = await second.getEntitiesByIds([AGENT_ID]);
		expect(entity?.names[0]).toBe("Nova");
	});
});
