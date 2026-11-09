/**
 * A narrow `onlyInclude` composition must not carry values or provider
 * records from providers the caller explicitly excluded: the returned text
 * is already rebuilt from the selected providers only, so values and
 * `data.providers` must agree with it.
 */
import { initializeTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRuntime } from "../src/runtime";
import type { Character } from "../src/types/agent.js";
import type { Memory } from "../src/types/memory.js";
import type { UUID } from "../src/types/primitives.js";

const ROOM_ID = "11111111-1111-1111-1111-111111111111" as UUID;
const ENTITY_ID = "22222222-2222-2222-2222-222222222222" as UUID;

const runtimes: AgentRuntime[] = [];
async function createRuntime(
	options: ConstructorParameters<typeof AgentRuntime>[0],
) {
	const runtime = new AgentRuntime({ ...options, agentId: ENTITY_ID });
	await initializeTestRuntime(runtime, { skipMigrations: true });
	runtimes.push(runtime);
	return runtime;
}
afterEach(async () => {
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
});

function makeMessage(id: string): Memory {
	return {
		id: id as UUID,
		entityId: ENTITY_ID,
		roomId: ROOM_ID,
		content: { text: "gm" },
	};
}

describe("composeState onlyInclude", () => {
	it("drops deselected providers from values and data.providers", async () => {
		const runtime = await createRuntime({
			character: { name: "only-include" } as Character,
		});
		runtime.registerProvider({
			name: "ALPHA",
			get: async () => ({
				text: "ALPHA",
				values: { alphaFlag: "x", canSend: true },
			}),
		});
		runtime.registerProvider({
			name: "BETA",
			get: async () => ({ text: "BETA", values: { betaFlag: "y" } }),
		});
		const message = makeMessage("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");

		const full = await runtime.composeState(message);
		expect(full.values.alphaFlag).toBe("x");
		expect(full.values.betaFlag).toBe("y");

		const narrow = await runtime.composeState(message, ["BETA"], true);
		expect(narrow.text).not.toContain("ALPHA");
		expect(narrow.values.betaFlag).toBe("y");
		expect(narrow.values.alphaFlag).toBeUndefined();
		expect(narrow.values.canSend).toBeUndefined();
		expect(
			Object.keys(narrow.data.providers as Record<string, unknown>),
		).toEqual(["BETA"]);
	});
});
