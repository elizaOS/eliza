/**
 * Proves WhatsApp inbound claim exclusion and fencing against a real runtime
 * and PGLite adapter. The suite exercises production document unique-insert
 * and compare-and-swap behavior; no database method is mocked.
 */
import {
	type AgentRuntime,
	createUniqueUuid,
	type Memory,
	type MemoryMetadata,
	MemoryType,
	type UUID,
} from "@elizaos/core";
import {
	createTestRuntime,
	type TestRuntimeResult,
} from "@elizaos/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	completeClaim,
	createInboundClaimId,
	tryClaim,
} from "../src/inbound-claim";

let testRuntime: TestRuntimeResult;
let runtime: AgentRuntime;

beforeAll(async () => {
	testRuntime = await createTestRuntime({ characterName: "WhatsAppClaimTest" });
	runtime = testRuntime.runtime;
}, 180_000);

afterAll(async () => {
	await testRuntime.cleanup();
});

describe("WhatsApp inbound claims on PGLite", () => {
	it("allows the same provider message id to be claimed independently in two chats", async () => {
		const externalMessageId = `wamid.cross-chat.${crypto.randomUUID()}`;
		const firstId = createInboundClaimId(runtime, "default", "chat-a", externalMessageId);
		const secondId = createInboundClaimId(runtime, "default", "chat-b", externalMessageId);

		expect(firstId).not.toBe(secondId);
		const [first, second] = await Promise.all([
			tryClaim(runtime, firstId, "default", "chat-a", externalMessageId),
			tryClaim(runtime, secondId, "default", "chat-b", externalMessageId),
		]);
		expect(first).toMatchObject({ won: true, state: { chatId: "chat-a" } });
		expect(second).toMatchObject({ won: true, state: { chatId: "chat-b" } });
	});

	it("elects one winner and preserves a distinct inbound message row", async () => {
		const externalMessageId = `wamid.race.${crypto.randomUUID()}`;
		const claimId = createInboundClaimId(runtime, "default", "chat", externalMessageId);
		const inboundMessageId = createUniqueUuid(
			runtime,
			`whatsapp:chat:${externalMessageId}`,
		) as UUID;

		const contenders = await Promise.all([
			tryClaim(runtime, claimId, "default", "chat", externalMessageId),
			tryClaim(runtime, claimId, "default", "chat", externalMessageId),
		]);
		expect(contenders.filter((result) => result.won)).toHaveLength(1);

		const winner = contenders.find((result) => result.won)?.state;
		expect(winner).not.toBeNull();
		if (!winner) throw new Error("PGLite claim race did not produce an owner");
		const activeClaim = await runtime.getMemoryById(claimId);
		if (!activeClaim) throw new Error("PGLite claim race did not persist its document");

		const inboundMessage: Memory = {
			id: inboundMessageId,
			entityId: runtime.agentId,
			agentId: runtime.agentId,
			roomId: activeClaim.roomId,
			worldId: activeClaim.worldId,
			content: { text: "real inbound WhatsApp payload", source: "whatsapp" },
			metadata: {
				type: "message",
				source: "whatsapp",
				messageIdFull: externalMessageId,
			} as MemoryMetadata,
			createdAt: Date.now(),
		};
		await runtime.createMemory(inboundMessage, "messages", true);
		await completeClaim(runtime, claimId, winner);

		const persistedClaim = await runtime.getMemoryById(claimId);
		const persistedMessage = await runtime.getMemoryById(inboundMessageId);
		expect(claimId).not.toBe(inboundMessageId);
		expect(persistedClaim?.metadata).toMatchObject({
			type: MemoryType.DOCUMENT,
			documentRevision: 1,
			whatsappClaim: { stage: "processed", revision: 1 },
		});
		expect(persistedMessage?.metadata).toMatchObject({
			type: "message",
			source: "whatsapp",
			messageIdFull: externalMessageId,
		});
	});

	it("atomically fences a stale owner and rejects its terminal write", async () => {
		const externalMessageId = `wamid.stale.${crypto.randomUUID()}`;
		const claimId = createInboundClaimId(runtime, "default", "chat", externalMessageId);
		const initial = await tryClaim(runtime, claimId, "default", "chat", externalMessageId);
		expect(initial.won).toBe(true);
		if (!initial.state) throw new Error("Initial PGLite claim has no state");

		const document = await runtime.getMemoryById(claimId);
		if (!document) throw new Error("Initial PGLite claim document was not stored");
		const staleState = {
			...initial.state,
			updatedAt: Date.now() - 10 * 60 * 1000,
		};
		await runtime.updateMemory({
			id: claimId,
			metadata: {
				...document.metadata,
				whatsappClaim: staleState,
			} as MemoryMetadata,
		});

		const successors = await Promise.all([
			tryClaim(runtime, claimId, "default", "chat", externalMessageId),
			tryClaim(runtime, claimId, "default", "chat", externalMessageId),
		]);
		expect(successors.filter((result) => result.won)).toHaveLength(1);
		const successor = successors.find((result) => result.won)?.state;
		expect(successor?.revision).toBe(1);
		expect(successor?.generation).not.toBe(initial.state.generation);

		await expect(completeClaim(runtime, claimId, initial.state)).rejects.toMatchObject({
			code: "WHATSAPP_INBOUND_CLAIM_CONFLICT",
		});
	});
});
