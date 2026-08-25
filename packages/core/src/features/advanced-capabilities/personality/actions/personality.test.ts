/**
 * Exercises the PERSONALITY action's dispatcher and parameter boundaries with
 * the real PersonalityStore and deterministic in-memory runtime harness. These
 * cases complement the capability-level suite by covering alias precedence,
 * unavailable services, invalid inputs, and response branches without a model.
 */
import { describe, expect, test } from "vitest";
import type {
	ActionResult,
	HandlerOptions,
	State,
	UUID,
} from "../../../../types/index.ts";
import {
	captureCallback,
	initStore,
	makeFakeRuntime,
	makeMessage,
} from "../__tests__/test-helpers.ts";
import * as personalityModule from "./personality.ts";

const { personalityAction } = personalityModule;
const TEST_SENDER = "00000000-0000-4000-8000-0000000000fe" as UUID;

async function run(
	fake: ReturnType<typeof makeFakeRuntime>,
	parameters: Record<string, unknown>,
): Promise<{
	result: ActionResult;
	calls: ReturnType<typeof captureCallback>["calls"];
}> {
	const message = makeMessage({
		entityId: TEST_SENDER,
		agentId: fake.runtime.agentId,
		text: "update personality",
	});
	const { cb, calls } = captureCallback();
	const options: HandlerOptions = { parameters: parameters as never };
	const result = (await personalityAction.handler(
		fake.runtime,
		message,
		undefined,
		options as unknown as Record<string, unknown>,
		cb,
	)) as ActionResult;
	return { result, calls };
}

describe("personalityAction dispatcher boundaries", () => {
	test("exports only the action from its implementation module", () => {
		expect(Object.keys(personalityModule)).toEqual(["personalityAction"]);
	});

	test("validates only when the store and a declared routing context are active", async () => {
		const fake = makeFakeRuntime();
		const message = makeMessage({
			entityId: TEST_SENDER,
			agentId: fake.runtime.agentId,
		});
		const settingsState = {
			values: {
				__contextRouting: { primaryContext: "settings" },
			},
		} as unknown as State;

		expect(
			await personalityAction.validate(fake.runtime, message, settingsState),
		).toBe(true);
		(fake.runtime as unknown as { getService: () => null }).getService = () =>
			null;
		expect(
			await personalityAction.validate(fake.runtime, message, settingsState),
		).toBe(false);
	});

	test("rejects a missing operation with the complete supported vocabulary", async () => {
		const fake = makeFakeRuntime();
		await initStore(fake);

		const { result, calls } = await run(fake, {});

		expect(result).toMatchObject({
			success: false,
			values: { error: "INVALID_OP" },
			data: { action: "PERSONALITY" },
		});
		expect((result.data as { ops: string[] }).ops).toEqual([
			"set_trait",
			"clear_trait",
			"set_reply_gate",
			"lift_reply_gate",
			"add_directive",
			"clear_directives",
			"load_profile",
			"save_profile",
			"list_profiles",
			"show_state",
		]);
		expect(calls).toHaveLength(1);
	});

	test("gives the legacy op alias precedence over action and subaction", async () => {
		const fake = makeFakeRuntime();
		await initStore(fake);

		const { result } = await run(fake, {
			op: "not-an-operation",
			action: "list_profiles",
			subaction: "show_state",
		});

		expect(result.values).toEqual({ error: "INVALID_OP" });
	});

	test("reports an unavailable store before dispatching a valid operation", async () => {
		const fake = makeFakeRuntime();
		(fake.runtime as unknown as { getService: () => null }).getService = () =>
			null;

		const { result, calls } = await run(fake, {
			action: "set_trait",
			scope: "user",
			trait: "tone",
			value: "warm",
		});

		expect(result).toMatchObject({
			success: false,
			values: { error: "SERVICE_UNAVAILABLE" },
			data: { action: "PERSONALITY", op: "set_trait" },
		});
		expect(calls[0].thought).toBe("personality store service not available");
	});
});

describe("personalityAction parameter boundaries", () => {
	test.each([
		["set_trait", { scope: "user", value: "warm" }, "trait"],
		["set_trait", { scope: "user", trait: "tone", value: "" }, "set it"],
		["clear_trait", { scope: "user", trait: "speed" }, "trait"],
		["set_reply_gate", { scope: "user", mode: "sometimes" }, "always reply"],
		["add_directive", { scope: "user", directive: "   " }, "directive text"],
	] as const)(
		"rejects invalid parameters for %s",
		async (action, parameters, expectedText) => {
			const fake = makeFakeRuntime();
			await initStore(fake);

			const { result } = await run(fake, { action, ...parameters });

			expect(result.values).toEqual({ error: "INVALID_PARAMETERS" });
			expect(result.text).toContain(expectedText);
		},
	);

	test.each(["load_profile", "save_profile"] as const)(
		"rejects a blank profile name for %s",
		async (action) => {
			const fake = makeFakeRuntime({ owner: TEST_SENDER });
			await initStore(fake);

			const { result } = await run(fake, { action, name: "   " });

			expect(result.values).toEqual({ error: "INVALID_PARAMETERS" });
		},
	);

	test.each([
		["verbosity", "verbose"],
		["tone", "cold"],
		["formality", "formal"],
	] as const)("accepts the valid %s value %s", async (trait, value) => {
		const fake = makeFakeRuntime();
		await initStore(fake);

		const { result } = await run(fake, {
			action: "set_trait",
			scope: "user",
			trait,
			value,
		});

		expect(result.success).toBe(true);
		expect(result.values).toMatchObject({ trait, value });
		expect(fake.store.getSlot(TEST_SENDER)[trait]).toBe(value);
	});

	test.each([
		["never_until_lift", "stay silent"],
		["on_mention", "only reply"],
		["addressed_or_ambient", "undirected"],
		["always", "respond normally"],
	] as const)("renders the user acknowledgement for %s", async (mode, text) => {
		const fake = makeFakeRuntime();
		await initStore(fake);

		const { result } = await run(fake, {
			action: "set_reply_gate",
			scope: "user",
			mode,
		});

		expect(result.success).toBe(true);
		expect(result.text).toContain(text);
		expect(fake.store.getSlot(TEST_SENDER).reply_gate).toBe(mode);
	});

	test("summarizes multiple directives and an explicit mention gate", async () => {
		const fake = makeFakeRuntime();
		await initStore(fake);
		await run(fake, {
			action: "add_directive",
			scope: "user",
			directive: "avoid emoji",
		});
		await run(fake, {
			action: "add_directive",
			scope: "user",
			directive: "use examples",
		});
		await run(fake, {
			action: "set_reply_gate",
			scope: "user",
			mode: "on_mention",
		});

		const { result } = await run(fake, {
			action: "show_state",
			scope: "user",
		});

		expect(result.text).toContain("replying only when mentioned");
		expect(result.text).toContain("2 custom directives");
	});
});
