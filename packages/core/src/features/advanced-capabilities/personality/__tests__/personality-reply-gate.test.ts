import { describe, expect, test } from "vitest";
import {
	decideReplyGate,
	messageContainsLiftSignal,
	resolveEffectiveReplyGate,
} from "../reply-gate.ts";
import {
	emptyPersonalitySlot,
	GLOBAL_PERSONALITY_SCOPE,
	type PersonalitySlot,
} from "../types.ts";

const AGENT_ID = "00000000-0000-4000-8000-000000000001" as `${string}-${string}-${string}-${string}-${string}`;
const USER_ID = "00000000-0000-4000-8000-000000000002" as `${string}-${string}-${string}-${string}-${string}`;

function userSlot(overrides: Partial<PersonalitySlot> = {}): PersonalitySlot {
	return { ...emptyPersonalitySlot(USER_ID, AGENT_ID), ...overrides };
}

function globalSlot(overrides: Partial<PersonalitySlot> = {}): PersonalitySlot {
	return {
		...emptyPersonalitySlot(GLOBAL_PERSONALITY_SCOPE, AGENT_ID),
		...overrides,
	};
}

describe("resolveEffectiveReplyGate", () => {
	test("user gate beats global gate (most-specific wins)", () => {
		const result = resolveEffectiveReplyGate(
			userSlot({ reply_gate: "never_until_lift" }),
			globalSlot({ reply_gate: "always" }),
		);
		expect(result).toEqual({ mode: "never_until_lift", scope: "user" });
	});

	test("falls through to global when user has no gate set", () => {
		const result = resolveEffectiveReplyGate(
			userSlot(),
			globalSlot({ reply_gate: "on_mention" }),
		);
		expect(result).toEqual({ mode: "on_mention", scope: "global" });
	});

	test("returns null when neither slot has a gate", () => {
		const result = resolveEffectiveReplyGate(userSlot(), globalSlot());
		expect(result).toEqual({ mode: null, scope: null });
	});
});

describe("decideReplyGate", () => {
	test("allows when no gate is set", () => {
		const decision = decideReplyGate({
			userSlot: userSlot(),
			globalSlot: globalSlot(),
			messageText: "hello",
			explicitlyAddressesAgent: false,
		});
		expect(decision.allow).toBe(true);
	});

	test("never_until_lift suppresses non-lift messages", () => {
		const decision = decideReplyGate({
			userSlot: userSlot({ reply_gate: "never_until_lift" }),
			globalSlot: globalSlot(),
			messageText: "what time is it",
			explicitlyAddressesAgent: false,
		});
		expect(decision.allow).toBe(false);
		if (!decision.allow) {
			expect(decision.reason).toBe("never_until_lift");
			expect(decision.gateMode).toBe("never_until_lift");
			expect(decision.scope).toBe("user");
		}
	});

	test("never_until_lift releases on explicit lift phrase", () => {
		const decision = decideReplyGate({
			userSlot: userSlot({ reply_gate: "never_until_lift" }),
			globalSlot: globalSlot(),
			messageText: "ok you can talk again",
			explicitlyAddressesAgent: false,
		});
		expect(decision.allow).toBe(true);
		if (decision.allow) {
			expect(decision.reason).toBe("lift_signal");
		}
	});

	test("never_until_lift releases on direct mention", () => {
		const decision = decideReplyGate({
			userSlot: userSlot({ reply_gate: "never_until_lift" }),
			globalSlot: globalSlot(),
			messageText: "hey @testagent",
			explicitlyAddressesAgent: true,
		});
		expect(decision.allow).toBe(true);
	});

	test("on_mention suppresses unaddressed messages", () => {
		const decision = decideReplyGate({
			userSlot: userSlot({ reply_gate: "on_mention" }),
			globalSlot: globalSlot(),
			messageText: "just chatting in the room",
			explicitlyAddressesAgent: false,
		});
		expect(decision.allow).toBe(false);
		if (!decision.allow) {
			expect(decision.reason).toBe("on_mention_not_addressed");
		}
	});

	test("on_mention allows addressed messages", () => {
		const decision = decideReplyGate({
			userSlot: userSlot({ reply_gate: "on_mention" }),
			globalSlot: globalSlot(),
			messageText: "@testagent what's up",
			explicitlyAddressesAgent: true,
		});
		expect(decision.allow).toBe(true);
	});

	test("always behaves like no gate", () => {
		const decision = decideReplyGate({
			userSlot: userSlot({ reply_gate: "always" }),
			globalSlot: globalSlot({ reply_gate: "never_until_lift" }),
			messageText: "hi",
			explicitlyAddressesAgent: false,
		});
		expect(decision.allow).toBe(true);
	});

	test("global never_until_lift applies when user has no gate", () => {
		const decision = decideReplyGate({
			userSlot: userSlot(),
			globalSlot: globalSlot({ reply_gate: "never_until_lift" }),
			messageText: "hello",
			explicitlyAddressesAgent: false,
		});
		expect(decision.allow).toBe(false);
		if (!decision.allow) {
			expect(decision.scope).toBe("global");
		}
	});
});

describe("messageContainsLiftSignal", () => {
	test("matches 'ok talk again' family", () => {
		expect(messageContainsLiftSignal("ok talk again", false)).toBe(true);
		expect(messageContainsLiftSignal("ok you can talk", false)).toBe(true);
		expect(messageContainsLiftSignal("okay talk again please", false)).toBe(
			true,
		);
	});

	test("matches unmute / unsilence", () => {
		expect(messageContainsLiftSignal("unmute", false)).toBe(true);
		expect(messageContainsLiftSignal("please unsilence", false)).toBe(true);
	});

	test("ignores tangential mentions of 'talk'", () => {
		expect(
			messageContainsLiftSignal("we should talk to bob about that", false),
		).toBe(false);
	});

	test("addressed-to-agent always counts as a lift", () => {
		expect(messageContainsLiftSignal("anything", true)).toBe(true);
	});
});
