/**
 * Regression suite for #29168: resolveAddressedTargets must resolve entity
 * names stored with a leading '@' (the shape connectors use for platform
 * handles, e.g. "@sol_eth"). The lookup side strips a leading '@' from the
 * tag, so the byName index must strip it too — otherwise a stored "@handle"
 * can never be resolved from either spelling, the alias-mapping contract on
 * messageAddressedToOtherParticipant silently fails, and an
 * other-participant handle tag leaves the gate fail-open.
 *
 * Kept as a dedicated file (rather than extending addressed-to.test.ts) so the
 * fix branch stays append-only against develop; runtime and its entity lookup
 * are vi-mocked, no model or database.
 */
import { describe, expect, it, vi } from "vitest";
import type { Entity, IAgentRuntime, Memory, UUID } from "../../types/index.ts";
import {
	messageAddressedToOtherParticipant,
	resolveAddressedTargets,
} from "../addressed-to.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;
const OTHER_BOT = "00000000-0000-0000-0000-0000000000bb" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const SENDER_ID = "00000000-0000-0000-0000-0000000000dd" as UUID;

function makeRuntime(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
	return {
		agentId: AGENT_ID,
		character: { name: "MyAgent" },
		getEntitiesForRoom: vi.fn(async () => [] as Entity[]),
		...overrides,
	} as unknown as IAgentRuntime;
}

function makeMessage(
	contentMetadata?: Record<string, unknown>,
	topLevelMetadata?: Record<string, unknown>,
	text = "do the thing",
): Memory {
	return {
		id: "00000000-0000-0000-0000-0000000000ee" as UUID,
		entityId: SENDER_ID,
		roomId: ROOM_ID,
		content: {
			text,
			...(contentMetadata ? { metadata: contentMetadata } : {}),
		},
		...(topLevelMetadata ? { metadata: topLevelMetadata } : {}),
	} as Memory;
}

describe("resolveAddressedTargets — stored @-prefixed platform handles (#29168)", () => {
	it("resolves a stored @-prefixed name when the tag also carries @", async () => {
		const runtime = makeRuntime({
			getEntitiesForRoom: vi.fn(async () => [
				{ id: OTHER_BOT, names: ["@sol_eth"] },
			]),
		} as unknown as Partial<IAgentRuntime>);
		expect(
			await resolveAddressedTargets({
				runtime,
				message: makeMessage(),
				addressedTo: ["@sol_eth"],
			}),
		).toEqual([OTHER_BOT]);
	});

	it("resolves a stored @-prefixed name when the tag omits @", async () => {
		const runtime = makeRuntime({
			getEntitiesForRoom: vi.fn(async () => [
				{ id: OTHER_BOT, names: ["@sol_eth"] },
			]),
		} as unknown as Partial<IAgentRuntime>);
		expect(
			await resolveAddressedTargets({
				runtime,
				message: makeMessage(),
				addressedTo: ["sol_eth"],
			}),
		).toEqual([OTHER_BOT]);
	});

	it("maps the agent's own stored @-prefixed alias to selfId", async () => {
		const runtime = makeRuntime({
			getEntitiesForRoom: vi.fn(async () => [
				{ id: AGENT_ID, names: ["@samantha_ai_bot"] },
			]),
		} as unknown as Partial<IAgentRuntime>);
		expect(
			await resolveAddressedTargets({
				runtime,
				message: makeMessage(),
				addressedTo: ["@samantha_ai_bot"],
			}),
		).toEqual([AGENT_ID]);
	});

	it("dedupes @ and bare spellings of the same stored handle", async () => {
		const runtime = makeRuntime({
			getEntitiesForRoom: vi.fn(async () => [
				{ id: OTHER_BOT, names: ["@sol_eth"] },
			]),
		} as unknown as Partial<IAgentRuntime>);
		expect(
			await resolveAddressedTargets({
				runtime,
				message: makeMessage(),
				addressedTo: ["@sol_eth", "sol_eth"],
			}),
		).toEqual([OTHER_BOT]);
	});

	it("keeps resolving plain (non-@) stored names — regression", async () => {
		const runtime = makeRuntime({
			getEntitiesForRoom: vi.fn(async () => [
				{ id: OTHER_BOT, names: ["SomeOtherBot"] },
			]),
		} as unknown as Partial<IAgentRuntime>);
		expect(
			await resolveAddressedTargets({
				runtime,
				message: makeMessage(),
				addressedTo: ["SomeOtherBot"],
			}),
		).toEqual([OTHER_BOT]);
	});

	it("gate: a stored @-prefixed OTHER-participant handle still gates (no fail-open)", async () => {
		// Without the fix the tag fails to resolve, targets is empty, the
		// other-participant branch never fires and the gate stays open even
		// though the message is verifiably directed at the tagged participant.
		const runtime = makeRuntime({
			getEntitiesForRoom: vi.fn(async () => [
				{ id: AGENT_ID, names: ["MyAgent"] },
				{ id: OTHER_BOT, names: ["@sol_eth"] },
			]),
		} as unknown as Partial<IAgentRuntime>);
		expect(
			await messageAddressedToOtherParticipant({
				runtime,
				message: makeMessage(
					undefined,
					undefined,
					"sol_eth can you take this one",
				),
				addressedTo: ["@sol_eth"],
			}),
		).toBe(true);
	});
});
