/** Verifies that durable Discord turn transitions persist with real AgentRuntime and PGlite. */
import { randomUUID } from "node:crypto";
import { ChannelType, type UUID } from "@elizaos/core";
import {
	createTestRuntime,
	type TestRuntimeResult,
} from "@elizaos/testing/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	claimDiscordTurn,
	DISCORD_TURN_MAX_ATTEMPTS,
	decideResume,
	loadDiscordTurn,
	markDiscordTurnDispatched,
	markDiscordTurnFailed,
	markDiscordTurnReplied,
} from "../turn-state.ts";

let fixture: TestRuntimeResult;
let conversation: { entityId: UUID; roomId: UUID; worldId: UUID };

beforeAll(async () => {
	fixture = await createTestRuntime();
	conversation = {
		entityId: randomUUID() as UUID,
		roomId: randomUUID() as UUID,
		worldId: randomUUID() as UUID,
	};
	await fixture.runtime.ensureConnection({
		...conversation,
		userName: "turn-owner",
		name: "Turn Owner",
		source: "discord",
		type: ChannelType.GROUP,
	});
}, 180_000);

afterAll(async () => {
	await fixture?.cleanup();
});

function newPlatformMessageId(): string {
	return `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
}

describe("durable Discord turn records with real SQL persistence", () => {
	it("stores each transition after the claim", async () => {
		const runtime = fixture.runtime;
		const repliedId = newPlatformMessageId();
		const { record } = await claimDiscordTurn(runtime, repliedId, conversation);

		await markDiscordTurnDispatched(runtime, record);
		expect(await loadDiscordTurn(runtime, repliedId)).toMatchObject({
			state: "DISPATCHED",
			attempts: 1,
		});

		const dispatched = await loadDiscordTurn(runtime, repliedId);
		if (!dispatched) throw new Error("turn record missing after dispatch");
		await markDiscordTurnReplied(runtime, dispatched, "reply-1");
		expect(await loadDiscordTurn(runtime, repliedId)).toMatchObject({
			state: "REPLIED",
			attempts: 1,
			replyMessageId: "reply-1",
		});

		const failedId = newPlatformMessageId();
		const failed = await claimDiscordTurn(runtime, failedId, conversation);
		await markDiscordTurnFailed(runtime, failed.record, "provider down");
		expect(await loadDiscordTurn(runtime, failedId)).toMatchObject({
			state: "FAILED",
			failureReason: "provider down",
		});
	});

	it("bounds redeliveries by the stored attempt count and ends a closed turn", async () => {
		const runtime = fixture.runtime;
		const platformMessageId = newPlatformMessageId();
		await claimDiscordTurn(runtime, platformMessageId, conversation);

		// Each redelivery with no reply memory resumes and dispatches again,
		// as MessageManager.handleMessage does, until the budget is spent.
		const decisions: string[] = [];
		for (let i = 0; i <= DISCORD_TURN_MAX_ATTEMPTS; i += 1) {
			const claim = await claimDiscordTurn(
				runtime,
				platformMessageId,
				conversation,
			);
			expect(claim.created).toBe(false);
			const decision = decideResume(claim.record, null);
			decisions.push(decision.action);
			if (decision.action === "resume") {
				await markDiscordTurnDispatched(runtime, claim.record);
			}
		}
		expect(decisions).toEqual(["resume", "resume", "resume", "exhausted"]);

		// An ingest-only close stamps the turn REPLIED; a later redelivery
		// must then be a no-op instead of another model turn.
		const closedId = newPlatformMessageId();
		const closed = await claimDiscordTurn(runtime, closedId, conversation);
		await markDiscordTurnReplied(runtime, closed.record);
		const redelivery = await claimDiscordTurn(runtime, closedId, conversation);
		expect(decideResume(redelivery.record, null)).toEqual({
			action: "noop",
			reason: "replied",
		});
	});
});
