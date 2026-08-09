/**
 * Covers the PERSONALITY action handler against the in-memory FakeRuntime and a
 * real PersonalityStore (no live model): scope-clarification for ambiguous
 * requests, trait/reply-gate/directive mutations, named-profile load/save, and
 * the audit-memory trail. Admin-only paths run on an owner-seeded runtime so
 * hasRoleAccess grants access.
 */
import { beforeEach, describe, expect, test } from "vitest";
import type { ActionResult, HandlerOptions } from "../../../../types/index.ts";
import { personalityAction } from "../actions/personality.ts";
import { GLOBAL_PERSONALITY_SCOPE, PERSONALITY_AUDIT_TABLE } from "../types.ts";
import {
	captureCallback,
	initStore,
	makeFakeRuntime,
	makeMessage,
} from "./test-helpers.ts";

describe("personalityAction — routing ownership", () => {
	test("does not claim the current-turn STOP_TALKING simile owned by IGNORE", () => {
		expect(personalityAction.similes).not.toContain("STOP_TALKING");
	});
});

// Fixed sender entity for the `run` helper. Pass it as `owner` to makeFakeRuntime
// when a test needs the sender treated as admin/owner (admin-only ops).
const TEST_SENDER = "00000000-0000-4000-8000-0000000000ff" as never;

async function run(
	fake: ReturnType<typeof makeFakeRuntime>,
	userText: string,
	op: string,
	extraParams: Record<string, unknown> = {},
) {
	const message = makeMessage({
		entityId: fake.runtime.agentId, // we'll override per-test for non-self
		agentId: fake.runtime.agentId,
		text: userText,
	});
	// Use a distinct entity for the message so it's not "from self"
	message.entityId = TEST_SENDER;
	const { cb, calls } = captureCallback();
	const opts: HandlerOptions = {
		parameters: { op, ...extraParams } as never,
	};
	const result = (await personalityAction.handler(
		fake.runtime,
		message,
		undefined,
		opts as unknown as Record<string, unknown>,
		cb,
	)) as ActionResult;
	return { result, calls, message };
}

describe("personalityAction — non-ambiguity (scope clarification)", () => {
	let fake: ReturnType<typeof makeFakeRuntime>;
	beforeEach(async () => {
		fake = makeFakeRuntime();
		await initStore(fake);
	});

	test("set_trait without scope returns clarification, not auto-pick", async () => {
		const { result, calls } = await run(fake, "be nicer", "set_trait", {
			trait: "tone",
			value: "warm",
		});
		expect(result.success).toBe(false);
		expect(result.values?.needsClarification).toBe(true);
		expect(calls[0].text).toMatch(/for you specifically, or globally/);
	});

	test("set_reply_gate without scope returns clarification", async () => {
		const { result } = await run(fake, "shut up", "set_reply_gate", {
			mode: "never_until_lift",
		});
		expect(result.success).toBe(false);
		expect(result.values?.needsClarification).toBe(true);
	});

	test("show_state without scope returns clarification", async () => {
		const { result } = await run(fake, "what's your personality", "show_state");
		expect(result.success).toBe(false);
		expect(result.values?.needsClarification).toBe(true);
	});
});

describe("personalityAction — subactions write structured state", () => {
	let fake: ReturnType<typeof makeFakeRuntime>;
	beforeEach(async () => {
		fake = makeFakeRuntime();
		await initStore(fake);
	});

	test("set_trait user-scope writes user slot only", async () => {
		const { result, calls } = await run(fake, "be terse with me", "set_trait", {
			scope: "user",
			trait: "verbosity",
			value: "terse",
		});
		expect(result.success).toBe(true);
		// #17923 humanization: the ack is a human sentence, not settings-speak
		// ("Set verbosity=terse for you."). Machine detail rides in values/data.
		expect(calls[0].text).toBe("Okay — I'll be terse with you from here on.");
		expect(calls[0].text).not.toContain("=");
		expect(result.values).toMatchObject({
			scope: "user",
			trait: "verbosity",
			value: "terse",
		});
		expect(
			(result.data as { after?: { verbosity?: string | null } }).after
				?.verbosity,
		).toBe("terse");
		const userSlot = fake.store.getSlot(
			"00000000-0000-4000-8000-0000000000ff" as never,
		);
		expect(userSlot.verbosity).toBe("terse");
		const globalSlot = fake.store.getSlot(GLOBAL_PERSONALITY_SCOPE);
		expect(globalSlot.verbosity).toBeNull();
	});

	test("set_trait invalid value rejects", async () => {
		const { result } = await run(fake, "be xxx", "set_trait", {
			scope: "user",
			trait: "verbosity",
			value: "bogus",
		});
		expect(result.success).toBe(false);
		expect(result.values?.error).toBe("INVALID_PARAMETERS");
	});

	test("set_reply_gate=never_until_lift writes the gate", async () => {
		const { result, calls } = await run(fake, "shut up", "set_reply_gate", {
			scope: "user",
			mode: "never_until_lift",
		});
		expect(result.success).toBe(true);
		expect(calls[0].text).toMatch(/silent until you/);
		const slot = fake.store.getSlot(
			"00000000-0000-4000-8000-0000000000ff" as never,
		);
		expect(slot.reply_gate).toBe("never_until_lift");
	});

	test("lift_reply_gate resets to 'always'", async () => {
		await run(fake, "shut up", "set_reply_gate", {
			scope: "user",
			mode: "never_until_lift",
		});
		const { result } = await run(fake, "ok talk again", "lift_reply_gate", {
			scope: "user",
		});
		expect(result.success).toBe(true);
		const slot = fake.store.getSlot(
			"00000000-0000-4000-8000-0000000000ff" as never,
		);
		expect(slot.reply_gate).toBe("always");
	});

	test("add_directive only allowed in user scope", async () => {
		const { result } = await run(fake, "remember this", "add_directive", {
			scope: "global",
			directive: "no emojis",
		});
		expect(result.success).toBe(false);
	});

	test("add_directive stores under user slot", async () => {
		const { result } = await run(fake, "no emojis please", "add_directive", {
			scope: "user",
			directive: "no emojis",
		});
		expect(result.success).toBe(true);
		const slot = fake.store.getSlot(
			"00000000-0000-4000-8000-0000000000ff" as never,
		);
		expect(slot.custom_directives).toContain("no emojis");
	});

	test("clear_directives wipes the user list", async () => {
		await run(fake, "no emojis", "add_directive", {
			scope: "user",
			directive: "no emojis",
		});
		const { result } = await run(
			fake,
			"clear preferences",
			"clear_directives",
			{
				scope: "user",
			},
		);
		expect(result.success).toBe(true);
		const slot = fake.store.getSlot(
			"00000000-0000-4000-8000-0000000000ff" as never,
		);
		expect(slot.custom_directives).toEqual([]);
	});

	test("show_state user returns slot summary", async () => {
		await run(fake, "be terse", "set_trait", {
			scope: "user",
			trait: "verbosity",
			value: "terse",
		});
		const { result, calls } = await run(fake, "show me", "show_state", {
			scope: "user",
		});
		expect(result.success).toBe(true);
		// Humanized summary — no key=value settings-speak in the spoken line; the
		// raw slot stays available as machine detail in data.slot.
		expect(calls[0].text).toContain("verbosity terse");
		expect(calls[0].text).not.toContain("=");
		expect(
			(result.data as { slot?: { verbosity?: string | null } }).slot?.verbosity,
		).toBe("terse");
	});
});

describe("personalityAction — profiles", () => {
	let fake: ReturnType<typeof makeFakeRuntime>;
	beforeEach(async () => {
		// load_profile / save_profile are admin-only; make the test sender the
		// canonical owner so hasRoleAccess grants admin (it now fails CLOSED on an
		// unresolved role — the old "no world → admin" leniency is gone).
		fake = makeFakeRuntime({ owner: TEST_SENDER });
		await initStore(fake);
	});

	test("list_profiles enumerates defaults", async () => {
		const { result, calls } = await run(fake, "list profiles", "list_profiles");
		expect(result.success).toBe(true);
		expect(calls[0].text).toContain("focused");
		expect(calls[0].text).toContain("default");
	});

	test("load_profile applies a known profile globally", async () => {
		const { result } = await run(fake, "load focused", "load_profile", {
			name: "focused",
		});
		expect(result.success).toBe(true);
		const globalSlot = fake.store.getSlot(GLOBAL_PERSONALITY_SCOPE);
		expect(globalSlot.verbosity).toBe("terse");
		expect(globalSlot.tone).toBe("direct");
	});

	test("load_profile with unknown name rejects", async () => {
		const { result } = await run(fake, "load mystery", "load_profile", {
			name: "mystery-profile-name",
		});
		expect(result.success).toBe(false);
	});

	test("save_profile snapshots current global state", async () => {
		await run(fake, "be terse", "set_trait", {
			scope: "global",
			trait: "verbosity",
			value: "terse",
		});
		const { result } = await run(fake, "save", "save_profile", {
			name: "my-favorite",
			description: "snapshot for testing",
		});
		expect(result.success).toBe(true);
		const profile = fake.store.getProfile("my-favorite");
		expect(profile?.verbosity).toBe("terse");
	});
});

describe("personalityAction — single-delivery settlement", () => {
	// Every success confirmation must settle as verified + turnComplete with the
	// callback text as the canonical userFacingText, so the action's own callback
	// is the turn's sole user-facing delivery. Without it, the evaluator rejects
	// a FINISH with an empty messageToUser and replans, and the user receives the
	// confirmation twice (observed live on set_reply_gate).
	const cases: Array<{
		op: string;
		userText: string;
		params: Record<string, unknown>;
	}> = [
		{
			op: "set_trait",
			userText: "be terse with me",
			params: { scope: "user", trait: "verbosity", value: "terse" },
		},
		{
			op: "clear_trait",
			userText: "reset verbosity",
			params: { scope: "user", trait: "verbosity" },
		},
		{
			op: "set_reply_gate",
			userText: "only reply when I mention you",
			params: { scope: "user", mode: "on_mention" },
		},
		{
			op: "lift_reply_gate",
			userText: "talk again",
			params: { scope: "user" },
		},
		{
			op: "add_directive",
			userText: "no emojis please",
			params: { scope: "user", directive: "no emojis" },
		},
		{
			op: "clear_directives",
			userText: "clear preferences",
			params: { scope: "user" },
		},
		{
			op: "load_profile",
			userText: "load focused",
			params: { name: "focused" },
		},
		{
			op: "save_profile",
			userText: "save this",
			params: { name: "snapshot", description: "test snapshot" },
		},
		{ op: "list_profiles", userText: "list profiles", params: {} },
		{ op: "show_state", userText: "show me", params: { scope: "user" } },
	];

	for (const { op, userText, params } of cases) {
		test(`${op} settles its confirmation as the sole user-facing delivery`, async () => {
			// Owner-seeded so the admin-only profile ops pass the role gate.
			const fake = makeFakeRuntime({ owner: TEST_SENDER });
			await initStore(fake);
			const { result, calls } = await run(fake, userText, op, params);
			expect(result.success).toBe(true);
			expect(calls).toHaveLength(1);
			expect(result.userFacingText).toBe(result.text);
			expect(calls[0].text).toBe(result.userFacingText);
			expect(result.verifiedUserFacing).toBe(true);
			expect(result.turnComplete).toBe(true);
		});
	}
});

describe("personalityAction — audit trail", () => {
	test("set_trait writes an audit memory of type personality_change", async () => {
		const fake = makeFakeRuntime();
		await initStore(fake);
		const { result } = await run(fake, "be terse", "set_trait", {
			scope: "user",
			trait: "verbosity",
			value: "terse",
		});
		expect(result.success).toBe(true);
		const audit = fake.memories.get(PERSONALITY_AUDIT_TABLE) ?? [];
		expect(audit.length).toBeGreaterThan(0);
		expect(audit[0].content.source).toBe("personality_change");
		const meta = audit[0].metadata as Record<string, unknown>;
		expect(meta.action).toBe("set_trait");
		expect(meta.personalityScope).toBe("user");
	});
});
