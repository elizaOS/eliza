/**
 * Exercises the TRUST umbrella's runtime export, discriminator normalization,
 * validation gates, and dispatch into each real trust subaction handler.
 */

import { describe, expect, test } from "vitest";
import type {
	ActionResult,
	IAgentRuntime,
	Memory,
	State,
} from "../../../types/index.ts";
import * as trustModule from "./trust.ts";

const { trustAction } = trustModule;

const message = {
	id: "message-id",
	entityId: "entity-id",
	roomId: "room-id",
	content: { text: "" },
} as Memory;

function runtimeWithTrustEngine(available: boolean): IAgentRuntime {
	return {
		agentId: "agent-id",
		getService: () => (available ? { trustEngine: {} } : null),
	} as unknown as IAgentRuntime;
}

async function run(
	options: Record<string, unknown> | undefined,
): Promise<ActionResult> {
	return (await trustAction.handler(
		runtimeWithTrustEngine(false),
		message,
		{} as State,
		options,
	)) as ActionResult;
}

describe("trustAction export and metadata", () => {
	test("exports only the TRUST umbrella action at runtime", () => {
		expect(Object.keys(trustModule)).toEqual(["trustAction"]);
		expect(trustAction).toMatchObject({
			name: "TRUST",
			contexts: ["admin", "settings", "agent_internal"],
			roleGate: { minRole: "USER" },
			suppressPostActionContinuation: true,
		});
		expect(
			trustAction.parameters?.find((parameter) => parameter.name === "action")
				?.schema,
		).toMatchObject({
			type: "string",
			enum: [
				"evaluate",
				"record_interaction",
				"request_elevation",
				"update_role",
			],
		});
	});
});

describe("trustAction validation", () => {
	test.each([
		{ action: "check" },
		{ subaction: "track" },
		{ op: "elevation" },
		{ operation: "make-admin" },
	])(
		"accepts a recognized structured discriminator without a trust engine",
		async (parameters) => {
			expect(
				await trustAction.validate(
					runtimeWithTrustEngine(false),
					message,
					undefined,
					{ parameters },
				),
			).toBe(true);
		},
	);

	test("requires the trust engine and an active declared context for free-form use", async () => {
		const settingsState = {
			values: { __contextRouting: { primaryContext: "settings" } },
		} as unknown as State;
		const unrelatedState = {
			values: { __contextRouting: { primaryContext: "calendar" } },
		} as unknown as State;

		expect(
			await trustAction.validate(
				runtimeWithTrustEngine(false),
				message,
				settingsState,
			),
		).toBe(false);
		expect(
			await trustAction.validate(
				runtimeWithTrustEngine(true),
				message,
				settingsState,
			),
		).toBe(true);
		expect(
			await trustAction.validate(
				runtimeWithTrustEngine(true),
				message,
				unrelatedState,
			),
		).toBe(false);
	});

	test("treats an unknown structured discriminator as free-form input", async () => {
		expect(
			await trustAction.validate(
				runtimeWithTrustEngine(false),
				message,
				undefined,
				{ parameters: { action: "unknown" } },
			),
		).toBe(false);
	});
});

describe("trustAction dispatch", () => {
	test.each([
		["evaluate", "evaluate"],
		["check", "evaluate"],
		["lookup", "evaluate"],
		["record_interaction", "record_interaction"],
		["record", "record_interaction"],
		["log interaction", "record_interaction"],
		["track", "record_interaction"],
		["request_elevation", "request_elevation"],
		["elevate", "request_elevation"],
		["elevation", "request_elevation"],
		["update_role", "update_role"],
		["assign_role", "update_role"],
		["set-role", "update_role"],
		["change role", "update_role"],
		["MAKE_ADMIN", "update_role"],
	] as const)("normalizes %s and routes to %s", async (action, subaction) => {
		const result = await run({ parameters: { action } });

		expect(result.success).toBe(false);
		expect(result.data).toMatchObject({ actionName: "TRUST", subaction });
	});

	test.each([
		[{ parameters: { action: " lookup " } }, "evaluate"],
		[{ subaction: "record" }, "record_interaction"],
		[{ op: "elevate" }, "request_elevation"],
		[{ operation: "assign role" }, "update_role"],
	] as const)(
		"reads each supported discriminator location %#",
		async (options, subaction) => {
			const result = await run(options);

			expect(result.data).toMatchObject({ subaction });
		},
	);

	test("prefers nested parameters and discriminator keys in documented order", async () => {
		const nestedWins = await run({
			action: "record",
			parameters: { action: "lookup" },
		});
		const actionWins = await run({
			parameters: { action: "lookup", subaction: "record" },
		});

		expect(nestedWins.data).toMatchObject({ subaction: "evaluate" });
		expect(actionWins.data).toMatchObject({ subaction: "evaluate" });
	});

	test.each([
		undefined,
		{},
		{ parameters: [] },
		{ parameters: { action: "   " } },
		{ parameters: { action: 42 } },
		{ parameters: { action: "unknown", subaction: "evaluate" } },
	])(
		"rejects a missing or invalid effective discriminator %#",
		async (options) => {
			const result = await run(options as Record<string, unknown> | undefined);

			expect(result).toEqual({
				success: false,
				text: "Specify a trust action: evaluate, record_interaction, request_elevation, or update_role.",
				error: "Missing trust subaction",
				data: { actionName: "TRUST" },
			});
		},
	);
});
