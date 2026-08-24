/**
 * Unit tests for personality reply gate: validates slot resolution order,
 * lift phrases, on_mention gating, and never_until_lift mute decisions.
 */
import { describe, expect, it } from "vitest";
import {
	decideReplyGate,
	messageContainsLiftSignal,
	resolveEffectiveReplyGate,
} from "./reply-gate.ts";

describe("reply-gate", () => {
	describe("resolveEffectiveReplyGate", () => {
		it("prioritizes user slot reply_gate over global slot", () => {
			const res = resolveEffectiveReplyGate(
				{ reply_gate: "on_mention" },
				{ reply_gate: "always" },
			);
			expect(res).toEqual({ mode: "on_mention", scope: "user" });
		});

		it("falls back to global slot when user slot is unset", () => {
			const res = resolveEffectiveReplyGate(null, {
				reply_gate: "never_until_lift",
			});
			expect(res).toEqual({ mode: "never_until_lift", scope: "global" });
		});

		it("returns null when neither is set", () => {
			expect(resolveEffectiveReplyGate(null, null)).toEqual({
				mode: null,
				scope: null,
			});
		});
	});

	describe("messageContainsLiftSignal", () => {
		it("returns true when explicitly addressing agent", () => {
			expect(messageContainsLiftSignal("hello", true)).toBe(true);
		});

		it("returns true on wake-up and lift phrases", () => {
			expect(messageContainsLiftSignal("okay talk again", false)).toBe(true);
			expect(messageContainsLiftSignal("you can talk", false)).toBe(true);
			expect(messageContainsLiftSignal("please unmute", false)).toBe(true);
			expect(messageContainsLiftSignal("lift the silence", false)).toBe(true);
			expect(messageContainsLiftSignal("wake up", false)).toBe(true);
			expect(messageContainsLiftSignal("start replying again", false)).toBe(
				true,
			);
		});

		it("returns false for casual mentions or unrelated text", () => {
			expect(messageContainsLiftSignal("we should talk about it", false)).toBe(
				false,
			);
			expect(messageContainsLiftSignal("", false)).toBe(false);
			expect(messageContainsLiftSignal(undefined, false)).toBe(false);
		});
	});

	describe("decideReplyGate", () => {
		it("allows response when gate mode is unset or always", () => {
			expect(
				decideReplyGate({
					userSlot: null,
					globalSlot: null,
					messageText: "hi",
					explicitlyAddressesAgent: false,
				}),
			).toEqual({ allow: true, reason: "no_gate" });
		});

		it("allows response for addressed_or_ambient mode", () => {
			expect(
				decideReplyGate({
					userSlot: { reply_gate: "addressed_or_ambient" },
					globalSlot: null,
					messageText: "hi",
					explicitlyAddressesAgent: false,
				}),
			).toEqual({ allow: true, reason: "addressed_or_ambient" });
		});

		it("handles on_mention gate mode correctly", () => {
			expect(
				decideReplyGate({
					userSlot: { reply_gate: "on_mention" },
					globalSlot: null,
					messageText: "@agent hi",
					explicitlyAddressesAgent: true,
				}),
			).toEqual({ allow: true, reason: "on_mention_satisfied" });

			expect(
				decideReplyGate({
					userSlot: { reply_gate: "on_mention" },
					globalSlot: null,
					messageText: "general message",
					explicitlyAddressesAgent: false,
				}),
			).toEqual({
				allow: false,
				reason: "on_mention_not_addressed",
				gateMode: "on_mention",
				scope: "user",
			});
		});

		it("handles never_until_lift gate mode correctly", () => {
			expect(
				decideReplyGate({
					userSlot: { reply_gate: "never_until_lift" },
					globalSlot: null,
					messageText: "wake up",
					explicitlyAddressesAgent: false,
				}),
			).toEqual({ allow: true, reason: "lift_signal" });

			expect(
				decideReplyGate({
					userSlot: null,
					globalSlot: { reply_gate: "never_until_lift" },
					messageText: "random comment",
					explicitlyAddressesAgent: false,
				}),
			).toEqual({
				allow: false,
				reason: "never_until_lift",
				gateMode: "never_until_lift",
				scope: "global",
			});
		});
	});
});
