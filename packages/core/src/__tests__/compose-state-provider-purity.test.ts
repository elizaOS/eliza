/**
 * composeState purity guard: the default Stage-1 provider set must never
 * acquire a hidden LLM round-trip (`runtime.useModel`) or an external network
 * fetch during state composition. Those belong in explicitly selected
 * providers or the action path, not the ambient compose that gates every
 * message turn's latency. The real basic and advanced provider bundles run
 * against an in-memory runtime while instrumented model and fetch boundaries
 * make accidental remote work observable.
 */
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { advancedProviders } from "../features/advanced-capabilities/index.ts";
import { basicProviders } from "../features/basic-capabilities/index.ts";
import { AgentRuntime } from "../runtime";
import type { Character, Memory, UUID } from "../types";
import { ChannelType } from "../types";

const WORLD_ID = "11111111-1111-1111-1111-111111111110" as UUID;
const ROOM_ID = "11111111-1111-1111-1111-111111111111" as UUID;
const ENTITY_ID = "22222222-2222-2222-2222-222222222222" as UUID;

async function makeRuntime(): Promise<AgentRuntime> {
	const adapter = new InMemoryDatabaseAdapter();
	const runtime = new AgentRuntime({
		character: { name: "purity-guard" } as Character,
		adapter,
		logLevel: "fatal",
	});
	await adapter.createWorlds([
		{
			id: WORLD_ID,
			agentId: runtime.agentId,
			name: "purity world",
			metadata: { roles: {} },
		},
	]);
	await adapter.createRooms([
		{
			id: ROOM_ID,
			agentId: runtime.agentId,
			source: "test",
			type: ChannelType.GROUP,
			worldId: WORLD_ID,
		},
	]);
	// The REAL default provider bundles — the same arrays the agent package
	// registers at boot — not synthetic stand-ins.
	for (const provider of [...basicProviders, ...advancedProviders]) {
		runtime.registerProvider(provider);
	}
	return runtime;
}

function makeMessage(id: string): Memory {
	return {
		id: id as UUID,
		entityId: ENTITY_ID,
		roomId: ROOM_ID,
		worldId: WORLD_ID,
		content: { text: "gm", source: "test" },
	} as Memory;
}

describe("composeState default-provider purity", () => {
	it("runs the real Stage-1 bundle with zero useModel calls and zero external fetches", async () => {
		const runtime = await makeRuntime();

		// Any model call during ambient compose is a latency regression; throwing
		// also prevents the test from accepting a fabricated provider result.
		const modelCalls: string[] = [];
		runtime.useModel = (async (modelType: unknown) => {
			modelCalls.push(String(modelType));
			throw new Error("useModel during composeState");
		}) as typeof runtime.useModel;

		// Record every fetch (covers fetchWithSsrfGuard and direct callers —
		// both resolve through globalThis.fetch) and return an empty 200 so a
		// regressing provider does not hang the test waiting on a socket.
		const fetchCalls: string[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			fetchCalls.push(String(input));
			return new Response("", { status: 200 });
		}) as typeof fetch;

		try {
			const state = await runtime.composeState(
				makeMessage("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
				null,
				false,
				true,
			);

			// Sanity: the bundle genuinely ran — ambient providers landed results
			// (an all-errored run would vacuously pass the purity assertions).
			// CURRENT_TIME and the other dynamic providers are correctly absent.
			const ranProviders = Object.keys(
				(state.data.providers as Record<string, unknown> | undefined) ?? {},
			);
			expect(ranProviders).toContain("CHARACTER");
			expect(ranProviders).toContain("ACTIONS");
			expect(ranProviders).toContain("RECENT_MESSAGES");
			expect(ranProviders.length).toBeGreaterThanOrEqual(10);
			expect(state.text.length).toBeGreaterThan(0);

			// The locks: no hidden LLM round-trip, no external network call.
			expect(modelCalls).toEqual([]);
			expect(fetchCalls).toEqual([]);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});
