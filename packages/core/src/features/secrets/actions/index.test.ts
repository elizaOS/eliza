/**
 * Exercises the secrets-actions barrel (`index.ts`): the re-exported
 * `SECRETS` action and mask helper preserve binding identity with the
 * defining module, importing the barrel eagerly registers the live action
 * under its unique bundle-safety key (the mobile tree-shake anchor), and
 * the planner-facing surface reached through the barrel still validates,
 * gates channels, dispatches, and reports failures correctly. The runtime
 * is a deterministic boundary stub; no handler module or secret
 * implementation is mocked.
 */

import { describe, expect, test } from "vitest";
import { anchorBundleSafety } from "../../../bundle-safety";
import { ChannelType } from "../../../types/primitives";
import * as barrel from "./index";
import {
	maskSecretValue as definedMaskSecretValue,
	secretsAction as definedSecretsAction,
} from "./manage-secret";

function createRuntime(serviceList?: () => Promise<Record<string, unknown>>) {
	return {
		agentId: "agent-1",
		getService: (name: string) =>
			name === "SECRETS" && serviceList ? { list: serviceList } : null,
		getSetting: () => undefined,
		composeState: async () => ({ values: {} }),
		dynamicPromptExecFromState: async () => ({}),
	};
}

function createMessage(channelType: ChannelType | undefined = ChannelType.DM) {
	return {
		entityId: "user-1",
		roomId: "room-1",
		content: { text: "manage a secret", channelType },
	};
}

async function validateThroughBarrel(
	parameters: unknown,
	channelType: ChannelType | undefined = ChannelType.DM,
	serviceAvailable = true,
) {
	return barrel.secretsAction.validate?.(
		createRuntime(serviceAvailable ? async () => ({}) : undefined) as never,
		createMessage(channelType) as never,
		undefined,
		{ parameters } as never,
	);
}

describe("secrets actions barrel", () => {
	test("re-exports the defining module's bindings, not copies", () => {
		expect(barrel.secretsAction).toBe(definedSecretsAction);
		expect(barrel.maskSecretValue).toBe(definedMaskSecretValue);
	});

	test("anchors the live action on globalThis under its unique key", () => {
		const anchored = (globalThis as Record<string, unknown>)
			.__bundle_safety_FEATURES_SECRETS_ACTIONS_INDEX__;

		expect(Array.isArray(anchored)).toBe(true);
		expect(anchored).toHaveProperty("length", 1);
		expect((anchored as unknown[])[0]).toBe(definedSecretsAction);
	});

	test("anchor helper writes distinct keys without clobbering this barrel's", () => {
		anchorBundleSafety("TEST_PROBE_NAMESPACE", []);

		expect(
			(globalThis as Record<string, unknown>)
				.__bundle_safety_TEST_PROBE_NAMESPACE__,
		).toEqual([]);
		expect(
			(globalThis as Record<string, unknown>)
				.__bundle_safety_FEATURES_SECRETS_ACTIONS_INDEX__,
		).toBeDefined();
	});

	test("mask helper reached through the barrel masks real values", () => {
		expect(barrel.maskSecretValue("123456789")).toBe("1234*6789");
		expect(barrel.maskSecretValue("short")).toBe("****");
	});

	test("validate through the barrel permits request in a public channel", async () => {
		expect(await validateThroughBarrel({ action: "request" })).toBe(true);
		expect(
			await validateThroughBarrel({ action: "  ReQuEsT  " }, ChannelType.GROUP),
		).toBe(true);
	});

	test("validate through the barrel keeps non-request actions DM-only", async () => {
		expect(await validateThroughBarrel({ action: "get" })).toBe(true);
		expect(
			await validateThroughBarrel({ action: "get" }, ChannelType.GROUP),
		).toBe(false);
	});

	test("handler through the barrel rejects unknown actions with an actionable failure", async () => {
		const result = await barrel.secretsAction.handler(
			createRuntime() as never,
			createMessage() as never,
			undefined,
			{ parameters: { action: "rotate" } } as never,
		);

		expect(result.success).toBe(false);
		expect(result.data).toMatchObject({
			actionName: "SECRETS",
			action: null,
		});
		expect(result.text).toContain("No clear secret operation");
	});

	test("handler through the barrel lists zero secrets when none are stored", async () => {
		const result = await barrel.secretsAction.handler(
			createRuntime(async () => ({})) as never,
			createMessage() as never,
			undefined,
			{ parameters: { action: "LIST" } } as never,
		);

		expect(result).toMatchObject({
			success: true,
			text: "You don't have any global secrets stored yet.",
			data: { actionName: "SECRETS", action: "list", keys: [] },
		});
	});

	test("handler through the barrel filters listed keys by prefix case-insensitively", async () => {
		const stored = {
			ZULU_LAST: { createdAt: 1 },
			ALPHA_FIRST: { createdAt: 2 },
			ALPHA_SECOND: { createdAt: 3 },
		};
		const result = await barrel.secretsAction.handler(
			createRuntime(async () => stored) as never,
			createMessage() as never,
			undefined,
			{ parameters: { action: "list", prefix: "alpha" } } as never,
		);

		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({
			actionName: "SECRETS",
			action: "list",
			keys: ["ALPHA_FIRST", "ALPHA_SECOND"],
		});
	});
});
