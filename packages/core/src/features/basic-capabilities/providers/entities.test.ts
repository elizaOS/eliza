/**
 * Contract tests for the ENTITIES ("People in the Room") provider. Pins the
 * context gate: the provider must be visible on messaging turns — not only
 * contacts/memory — so the planner can see that an addressee is PRESENT in the
 * room and prefer a plain in-room reply over a contact search or DM lookup
 * (the "tell <name> …" over-routing family). Deterministic mocked runtime.
 */
import { describe, expect, it } from "vitest";
import { createMockRuntime } from "../../../testing/mock-runtime";
import type { IAgentRuntime, Memory, UUID } from "../../../types/index.ts";
import { entitiesProvider } from "./entities.ts";

describe("ENTITIES provider context gate", () => {
	it("is visible on messaging turns as well as contacts/memory", () => {
		expect(entitiesProvider.contexts).toContain("messaging");
		expect(entitiesProvider.contexts).toContain("contacts");
		expect(entitiesProvider.contexts).toContain("memory");
		const gate = entitiesProvider.contextGate as { anyOf?: string[] };
		expect(gate?.anyOf).toContain("messaging");
	});
});

describe("ENTITIES provider content", () => {
	it("lists the people present in the room", async () => {
		const roomId = "00000000-0000-0000-0000-0000000000bb" as UUID;
		const runtime = createMockRuntime({
			agentId: "00000000-0000-0000-0000-000000000001" as UUID,
			getRoom: (async () => ({
				id: roomId,
				source: "discord",
				name: "#general",
			})) as IAgentRuntime["getRoom"],
			getEntitiesForRoom: (async () => [
				{
					id: "00000000-0000-0000-0000-0000000000e1" as UUID,
					agentId: "00000000-0000-0000-0000-000000000001" as UUID,
					names: ["Vega"],
					components: [],
				},
			]) as IAgentRuntime["getEntitiesForRoom"],
		});
		const message = {
			id: "00000000-0000-0000-0000-0000000000aa",
			roomId,
			entityId: "00000000-0000-0000-0000-0000000000cc",
			content: { text: "tell vega to take a break", source: "discord" },
		} as unknown as Memory;

		const result = await entitiesProvider.get(runtime, message, {
			values: {},
			data: {},
			text: "",
		});
		expect(result.text).toContain("People in the Room");
		expect(result.text).toContain("Vega");
	});
});
