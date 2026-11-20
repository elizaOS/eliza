/**
 * Replays quint/CanonicalRecallRenewal.qnt through
 * searchCanonicalConversationMemories on an initialized runtime with real
 * SQLite storage. The clock moves past the real five-minute evidence TTL; the
 * TTL itself is never shortened.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchCanonicalConversationMemories } from "../src/access-control/provenance-envelope";
import type { AgentRuntime } from "../src/runtime";
import {
	attestDeliveryAudienceFromCanonicalRoom,
	beginTrustedDeliveryAudienceTurn,
	getTrustedDeliveryAudience,
} from "../src/security/trusted-delivery-audience";
import type { Memory } from "../src/types/memory";
import { ChannelType, type UUID } from "../src/types/primitives";
import { stringToUuid } from "../src/utils/string-to-uuid";
import { createInitializedRuntime } from "./initialized-runtime";

/** The default evidence TTL (DEFAULT_ATTESTATION_TTL_MS). */
const TTL_MS = 5 * 60_000;
const ACTIONS = ["expire", "end", "cancel", "join", "search"] as const;
type Action = (typeof ACTIONS)[number];
/** outcome: 0 no search yet, 1 complete with the stored row, 2 unavailable. */
interface ModelStep {
	action: Action;
	fresh: boolean;
	active: boolean;
	changed: boolean;
	outcome: number;
}
type ModelCase = ModelStep[];

const step = (
	action: Action,
	fresh: boolean,
	active: boolean,
	changed: boolean,
	outcome: number,
): ModelStep => ({ action, fresh, active, changed, outcome });

// Without generated cases, each first action replays these sequences.
const DEFAULT_CASES: ModelCase[] = [
	[step("search", true, true, false, 1)],
	[step("expire", false, true, false, 0), step("search", true, true, false, 1)],
	[
		step("expire", false, true, false, 0),
		step("end", false, false, false, 0),
		step("search", false, false, false, 2),
	],
	[
		step("end", true, false, false, 0),
		step("search", true, false, false, 1),
		step("expire", false, false, false, 1),
		step("search", false, false, false, 2),
	],
	[
		step("cancel", true, false, false, 0),
		step("expire", false, false, false, 0),
		step("search", false, false, false, 2),
	],
	[
		step("join", true, true, true, 0),
		step("search", true, true, true, 1),
		step("expire", false, true, true, 1),
		step("search", false, true, true, 2),
	],
];
const casesFile = process.env.ELIZA_CANONICAL_RECALL_RENEWAL_MODEL_CASES;
const cases: ModelCase[] = casesFile
	? JSON.parse(readFileSync(casesFile, "utf8"))
	: DEFAULT_CASES;

let seq = 0;
const id = (label: string) => stringToUuid(`recall-renewal-${label}`) as UUID;

/** One group room: the requester, the agent and one stored row to recall. */
async function openTurn(runtime: AgentRuntime) {
	seq++;
	const worldId = id(`world-${seq}`);
	const roomId = id(`room-${seq}`);
	const requester = id(`requester-${seq}`);
	await runtime.createWorld({ id: worldId, agentId: runtime.agentId });
	await runtime.createRoom({
		id: roomId,
		source: "discord",
		type: ChannelType.GROUP,
		worldId,
	});
	await runtime.createEntity({
		id: requester,
		names: ["requester"],
		agentId: runtime.agentId,
	});
	await runtime.addParticipant(requester, roomId);
	await runtime.addParticipant(runtime.agentId, roomId);
	const storedId = id(`stored-${seq}`);
	await runtime.createMemory(
		{
			id: storedId,
			entityId: requester,
			agentId: runtime.agentId,
			roomId,
			worldId,
			createdAt: Date.now(),
			content: { text: "We moved the deploy to Friday.", source: "discord" },
			// The stamped shape a Discord connector stores (see
			// plugins/plugin-discord/__tests__/canonical-provenance-envelope.real.test.ts).
			metadata: {
				type: "message",
				provider: "discord",
				accountId: "discord-account-1",
				scope: "room",
				messageIdFull: `discord-message-${seq}`,
				discord: { userId: "discord-user-1" },
			} as Memory["metadata"],
			embedding: [1, 0, 0],
		},
		"messages",
	);
	const delivery: Memory = {
		id: id(`delivery-${seq}`),
		entityId: requester,
		agentId: runtime.agentId,
		roomId,
		createdAt: Date.now(),
		content: { text: "When is the deploy again?", source: "discord" },
	};
	await attestDeliveryAudienceFromCanonicalRoom(runtime, delivery);
	const controller = new AbortController();
	const end = beginTrustedDeliveryAudienceTurn(runtime, delivery, {
		signal: controller.signal,
	});
	return { roomId, storedId, delivery, end, controller };
}

async function replay(runtime: AgentRuntime, modelCase: ModelCase) {
	const turn = await openTurn(runtime);
	let outcome = 0;
	for (const [index, expected] of modelCase.entries()) {
		switch (expected.action) {
			case "expire":
				vi.setSystemTime(Date.now() + TTL_MS + 1_000);
				break;
			case "end":
				turn.end();
				break;
			case "cancel":
				turn.controller.abort();
				break;
			case "join": {
				const joiner = id(`joiner-${seq}`);
				await runtime.createEntity({
					id: joiner,
					names: ["joiner"],
					agentId: runtime.agentId,
				});
				await runtime.addParticipant(joiner, turn.roomId);
				break;
			}
			case "search": {
				const recall = await searchCanonicalConversationMemories({
					runtime,
					embedding: [1, 0, 0],
					deliveryMessage: turn.delivery,
				});
				const ids = recall.items.map((item) => item.memory.id);
				outcome =
					recall.availability === "complete" && ids.includes(turn.storedId)
						? 1
						: recall.availability === "unavailable" && ids.length === 0
							? 2
							: -1;
				break;
			}
		}
		const evidence = getTrustedDeliveryAudience(turn.delivery);
		const where = `step ${index + 1} (${expected.action}) of ${JSON.stringify(modelCase.map((item) => item.action))}`;
		expect(outcome, where).toBe(expected.outcome);
		expect((evidence?.expiresAtMs ?? 0) > Date.now(), where).toBe(
			expected.fresh,
		);
	}
	turn.end();
}

afterEach(() => {
	vi.useRealTimers();
});

describe("canonical recall renewal model", () => {
	it.each([...ACTIONS])(
		"replays the canonical recall renewal model from %s",
		async (first) => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(Date.UTC(2026, 10, 14, 7, 0, 0));
			const runtime = await createInitializedRuntime({
				character: { name: "Recall renewal", bio: [] },
				logLevel: "fatal",
			});
			await runtime.adapter.ensureEmbeddingDimension(3);
			const own = cases.filter((item) => item[0]?.action === first);
			expect(own.length).toBeGreaterThan(0);
			for (const modelCase of own) await replay(runtime, modelCase);
		},
	);
});
