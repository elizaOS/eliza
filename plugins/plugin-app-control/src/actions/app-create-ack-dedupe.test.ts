/**
 * Regression coverage for the one-kickoff-bubble rule on APP create/edit
 * dispatches (live 2026-08-24, create-app:daily-hue): the orchestrator's
 * TASKS create posted its early model-phrased ack ("I'm working on creating
 * the daily-hue app for you…") and app-create then posted its own "Building
 * Daily Hue now — I'll post the link once it's live." — two kickoff bubbles
 * for one build, interleaved into an unrelated Q&A as a three-bubble pile-up.
 * `delegatedKickoffAckDelivery` is the structural read that lets app-create
 * skip its own line whenever the delegation already delivered the ack.
 */

import type { ActionResult } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { delegatedKickoffAckDelivery } from "./app-create.js";

describe("delegatedKickoffAckDelivery", () => {
	it("reports delivered with the claimed text when the delegation acked via callback (verifiedUserFacing)", () => {
		// runCreateLegacy's callback-delivery shape (ackPostedOutOfBand=false):
		// the exact shape observed in the daily-hue incident.
		const result: ActionResult = {
			success: true,
			text: "Acknowledged and started the build; results arrive as follow-up messages.",
			userFacingText:
				"I'm working on creating the daily-hue app for you. Everything is moving along steadily, and I'll let you know as soon as there's a result to share.",
			verifiedUserFacing: true,
			data: { agents: [] },
		};
		expect(delegatedKickoffAckDelivery(result)).toEqual({
			delivered: true,
			text: result.userFacingText,
		});
	});

	it("reports delivered without text on the out-of-band ack contract (suppressPlannerReply)", () => {
		// runCreateLegacy's out-of-band shape (ackPostedOutOfBand=true): the
		// result deliberately never re-claims the sent text.
		const result: ActionResult = {
			success: true,
			text: "Acknowledged and started the build; results arrive as follow-up messages.",
			data: { agents: [], suppressPlannerReply: true },
		};
		expect(delegatedKickoffAckDelivery(result)).toEqual({ delivered: true });
	});

	it("reports not delivered when the delegation made no user-facing claim", () => {
		const result: ActionResult = {
			success: true,
			text: "Spawned coding sub-agent.",
			data: { agents: [] },
		};
		expect(delegatedKickoffAckDelivery(result)).toEqual({ delivered: false });
	});

	it("does not treat an unverified userFacingText as a delivered ack", () => {
		const result: ActionResult = {
			success: true,
			text: "planner grounding",
			userFacingText: "some paraphrase the settle layer may still rewrite",
			data: {},
		};
		expect(delegatedKickoffAckDelivery(result)).toEqual({ delivered: false });
	});

	it("does not treat a whitespace-only claim as a delivered ack", () => {
		const result: ActionResult = {
			success: true,
			text: "planner grounding",
			userFacingText: "   ",
			verifiedUserFacing: true,
			data: {},
		};
		expect(delegatedKickoffAckDelivery(result)).toEqual({ delivered: false });
	});

	it("reports not delivered for a missing result", () => {
		expect(delegatedKickoffAckDelivery(undefined)).toEqual({
			delivered: false,
		});
	});
});
