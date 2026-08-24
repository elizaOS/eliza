/**
 * Unit tests for botAwareness provider: validates bot loop assessment,
 * exchange depth escalation, and provider metadata.
 */
import { describe, expect, it } from "vitest";
import {
	assessBotLoop,
	botAwarenessProvider,
	DEEP_BOT_LOOP_DEPTH,
} from "./botAwareness.ts";
import type { GroupConversationMetrics } from "./group-conversation-signals.ts";

describe("botAwareness", () => {
	describe("assessBotLoop", () => {
		it("is inactive when latest message is not from bot", () => {
			const metrics: GroupConversationMetrics = {
				latestFromBot: false,
				botTurnsSinceLastHuman: 0,
				agentTurnsSinceLastHuman: 1,
				recentParticipantCount: 2,
				lastHumanMessageTimestamp: Date.now(),
			};

			const res = assessBotLoop(metrics);
			expect(res.active).toBe(false);
			expect(res.deep).toBe(false);
		});

		it("is active when bot and agent have exchanges with no human turn", () => {
			const metrics: GroupConversationMetrics = {
				latestFromBot: true,
				botTurnsSinceLastHuman: 2,
				agentTurnsSinceLastHuman: 1,
				recentParticipantCount: 2,
				lastHumanMessageTimestamp: Date.now() - 10000,
			};

			const res = assessBotLoop(metrics);
			expect(res.active).toBe(true);
			expect(res.exchangeDepth).toBe(3);
			expect(res.deep).toBe(false);
		});

		it("escalates to deep when exchangeDepth reaches DEEP_BOT_LOOP_DEPTH", () => {
			const metrics: GroupConversationMetrics = {
				latestFromBot: true,
				botTurnsSinceLastHuman: 3,
				agentTurnsSinceLastHuman: 2,
				recentParticipantCount: 2,
				lastHumanMessageTimestamp: Date.now() - 20000,
			};

			const res = assessBotLoop(metrics);
			expect(res.active).toBe(true);
			expect(res.exchangeDepth).toBe(5);
			expect(res.deep).toBe(true);
			expect(DEEP_BOT_LOOP_DEPTH).toBe(4);
		});
	});

	describe("botAwarenessProvider metadata", () => {
		it("satisfies provider contract properties", () => {
			expect(botAwarenessProvider.name).toBe("BOT_AWARENESS");
			expect(botAwarenessProvider.dynamic).toBe(true);
			expect(botAwarenessProvider.position).toBe(-3);
			expect(botAwarenessProvider.alwaysInResponseState).toBe(true);
		});
	});
});
