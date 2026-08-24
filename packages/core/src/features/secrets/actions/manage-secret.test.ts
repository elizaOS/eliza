/**
 * Exercises the planner-facing `SECRETS` umbrella action: validation gates,
 * normalized action resolution, rejection of unknown operations, and dispatch
 * to every real atomic handler. The runtime is a deterministic boundary stub;
 * no handler module, model, database, or secret implementation is mocked.
 */

import { describe, expect, test } from "vitest";
import { ChannelType } from "../../../types/primitives";
import { maskSecretValue, secretsAction } from "./manage-secret";

function createRuntime(hasSecretsService = true) {
	return {
		agentId: "agent-1",
		getService: (name: string) =>
			name === "SECRETS" && hasSecretsService ? {} : null,
		getSetting: () => undefined,
		composeState: async () => ({ values: {} }),
		dynamicPromptExecFromState: async () => ({}),
	};
}

function createMessage(
	channelType: ChannelType | undefined = ChannelType.DM,
	metadata?: Record<string, unknown>,
) {
	return {
		entityId: "user-1",
		roomId: "room-1",
		content: { text: "manage a secret", channelType, metadata },
	};
}

async function validate(
	parameters: unknown,
	channelType: ChannelType | undefined = ChannelType.DM,
	metadata?: Record<string, unknown>,
	serviceAvailable = true,
) {
	return secretsAction.validate?.(
		createRuntime(serviceAvailable) as never,
		createMessage(channelType, metadata) as never,
		undefined,
		{ parameters } as never,
	);
}

async function handle(parameters: unknown) {
	return secretsAction.handler(
		createRuntime(false) as never,
		createMessage() as never,
		undefined,
		{ parameters } as never,
	);
}

describe("SECRETS umbrella action", () => {
	test("publishes the planner-facing action contract", () => {
		expect(secretsAction).toMatchObject({
			name: "SECRETS",
			contexts: ["secrets", "settings", "connectors"],
			roleGate: { minRole: "OWNER" },
			suppressPostActionContinuation: true,
		});
		expect(secretsAction.parameters?.[0]).toMatchObject({
			name: "action",
			required: true,
			schema: {
				type: "string",
				enum: ["get", "set", "delete", "list", "check", "mirror", "request"],
			},
		});
	});

	test("re-exports the secret masking implementation", () => {
		expect(maskSecretValue("123456789")).toBe("1234*6789");
	});

	test("fails validation when the secrets service is unavailable", async () => {
		expect(
			await validate(
				{ action: "request" },
				ChannelType.GROUP,
				undefined,
				false,
			),
		).toBe(false);
	});

	test("normalizes request and permits it in a public channel", async () => {
		expect(await validate({ action: "  ReQuEsT  " }, ChannelType.GROUP)).toBe(
			true,
		);
	});

	test.each(["get", "set", "delete", "list", "check", "mirror"])(
		"rejects action=%s in a public channel",
		async (action) => {
			expect(await validate({ action }, ChannelType.GROUP)).toBe(false);
		},
	);

	test.each([
		["a supported action", { action: "get" }],
		["a non-empty key", { key: " OPENAI_API_KEY " }],
		["a non-empty secrets array", { secrets: [{ key: "K", value: "V" }] }],
	])("accepts %s as a structured DM signal", async (_label, parameters) => {
		expect(await validate(parameters)).toBe(true);
	});

	test("accepts a supported action when channel type is omitted", async () => {
		expect(await validate({ action: "list" }, undefined)).toBe(true);
	});

	test("falls back to explicit secrets routing context", async () => {
		expect(
			await validate({}, ChannelType.DM, {
				__responseContext: { primaryContext: "secrets" },
			}),
		).toBe(true);
	});

	test.each([
		["missing parameters", undefined],
		["null parameters", null],
		["non-object parameters", "request"],
		["an unknown action", { action: "rotate" }],
		["a blank key", { key: "   " }],
		["an empty secrets array", { secrets: [] }],
	])("rejects %s without a matching context", async (_label, parameters) => {
		expect(await validate(parameters)).toBe(false);
	});

	test.each([
		["missing parameters", undefined],
		["a non-string action", { action: 42 }],
		["a blank action", { action: "   " }],
		["an unknown action", { action: "rotate" }],
	])("returns an actionable failure for %s", async (_label, parameters) => {
		const result = await handle(parameters);

		expect(result).toMatchObject({
			success: false,
			data: { actionName: "SECRETS", action: null },
		});
		expect(result.text).toContain("No clear secret operation");
	});

	test.each([
		[" GET ", "get"],
		["SET", "set"],
		["delete", "delete"],
		["list", "list"],
		["check", "check"],
		["mirror", "mirror"],
		["request", "request"],
	])("dispatches %s to the real %s handler", async (input, expected) => {
		const result = await handle({ action: input, key: "OPENAI_API_KEY" });

		expect(result.data).toMatchObject({
			actionName: "SECRETS",
			action: expected,
		});
	});
});
