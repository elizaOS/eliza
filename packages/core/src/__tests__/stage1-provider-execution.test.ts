/**
 * Proves the Stage-1 provider exclusions are EXECUTION exclusions, not just
 * render exclusions: `stage1ResponseStateProviderNames` subtracts the
 * stage-1-excluded providers from the compose include list (so ENTITIES /
 * CURRENT_TIME never run for a turn that dies at Stage 1), while the planner
 * pass still composes them via composeState's cached-state merge. Uses a real
 * in-memory AgentRuntime with call-counting providers; no database or model.
 */
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../runtime";
import { stage1ResponseStateProviderNames } from "../services/message";
import type {
	Character,
	IAgentRuntime,
	Memory,
	Provider,
	UUID,
} from "../types";

const ROOM_ID = "11111111-1111-1111-1111-111111111111" as UUID;
const ENTITY_ID = "22222222-2222-2222-2222-222222222222" as UUID;

function makeMessage(id: string, text = "gm"): Memory {
	return {
		id: id as UUID,
		entityId: ENTITY_ID,
		roomId: ROOM_ID,
		content: { text },
	};
}

/** Provider whose text changes on every run, so reuse vs re-run is observable. */
function countingProvider(name: string): {
	provider: Provider;
	calls: () => number;
} {
	let n = 0;
	return {
		provider: {
			name,
			get: async () => {
				n += 1;
				return { text: `${name}#${n}`, values: {}, data: {} };
			},
		},
		calls: () => n,
	};
}

describe("stage1ResponseStateProviderNames", () => {
	it("subtracts the stage-1 exclusions from the compose include list", () => {
		const runtime = { providers: [] } as unknown as IAgentRuntime;
		const names = stage1ResponseStateProviderNames(
			runtime,
			makeMessage("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1"),
		);

		expect(names).not.toContain("ENTITIES");
		expect(names).not.toContain("CURRENT_TIME");
		expect(names).not.toContain("DOCUMENTS");
		// Stage 1 still composes what it renders and routes on.
		expect(names).toContain("RECENT_MESSAGES");
		expect(names).toContain("FACTS");
		expect(names).toContain("ATTACHMENTS");
	});

	it("keeps CURRENT_TIME when the user is asking about the time", () => {
		const runtime = { providers: [] } as unknown as IAgentRuntime;
		const names = stage1ResponseStateProviderNames(
			runtime,
			makeMessage("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2", "what time is it?"),
		);

		expect(names).toContain("CURRENT_TIME");
		expect(names).not.toContain("ENTITIES");
	});

	it("includes always-on plugin providers unless they are stage-1-excluded", () => {
		const runtime = {
			providers: [
				{
					name: "PLUGIN_CTX",
					alwaysInResponseState: true,
					get: async () => ({}),
				},
				{
					name: "DOCUMENTS",
					alwaysInResponseState: true,
					get: async () => ({}),
				},
			],
		} as unknown as IAgentRuntime;
		const names = stage1ResponseStateProviderNames(
			runtime,
			makeMessage("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3"),
		);

		expect(names).toContain("PLUGIN_CTX");
		expect(names).not.toContain("DOCUMENTS");
	});

	it("skips excluded providers at stage 1 and defers them to the planner recompose", async () => {
		const runtime = new AgentRuntime({
			character: { name: "stage1-exec-test" } as Character,
		});
		const entities = countingProvider("ENTITIES");
		const currentTime = countingProvider("CURRENT_TIME");
		const facts = countingProvider("FACTS");
		const recent = countingProvider("RECENT_MESSAGES");
		for (const p of [entities, currentTime, facts, recent]) {
			runtime.registerProvider(p.provider);
		}

		const message = makeMessage("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
		const stage1Names = stage1ResponseStateProviderNames(runtime, message);

		// Stage-1 compose: excluded providers never execute, so a turn that
		// ends at Stage 1 (group noise → IGNORE) does none of their work and
		// its prompt footprint drops accordingly.
		const stage1State = await runtime.composeState(
			message,
			stage1Names,
			true,
			false,
		);
		expect(entities.calls()).toBe(0);
		expect(currentTime.calls()).toBe(0);
		expect(facts.calls()).toBe(1);
		expect(recent.calls()).toBe(1);
		expect(stage1State.text).not.toContain("ENTITIES#");
		expect(stage1State.text).not.toContain("CURRENT_TIME#");
		expect(stage1State.text).toContain("FACTS#1");

		// Planner recompose (mirrors selectV5PlannerStateProviderNames re-adding
		// the core response providers, with RECENT_MESSAGES refreshed): the
		// excluded providers are not in the turn cache, so they run now — once —
		// and reach the planner prompt; the already-composed FACTS is reused.
		const plannerState = await runtime.composeState(
			message,
			[...stage1Names, "ENTITIES", "CURRENT_TIME"],
			true,
			false,
			["RECENT_MESSAGES"],
		);
		expect(entities.calls()).toBe(1);
		expect(currentTime.calls()).toBe(1);
		expect(facts.calls()).toBe(1);
		expect(recent.calls()).toBe(2);
		expect(plannerState.text).toContain("ENTITIES#1");
		expect(plannerState.text).toContain("CURRENT_TIME#1");
		expect(plannerState.text).toContain("FACTS#1");
		expect(plannerState.text).toContain("RECENT_MESSAGES#2");
	});
});
