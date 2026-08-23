/**
 * Exercises `setSecretHandler`, the SECRETS umbrella's `action=set` path,
 * across channel gating, extraction, context selection, write outcomes, and
 * user-facing responses. The runtime and secrets service are deterministic
 * fakes; the real handler performs all parsing, normalization, and aggregation.
 */

import { describe, expect, test } from "vitest";
import { ChannelType, ModelType } from "../../../types/index";
import { setSecretHandler } from "./set-secret";

interface SecretInput {
	key: string;
	value: string;
	description?: string;
	type?: string;
}

interface SetCall {
	key: string;
	value: string;
	context: Record<string, unknown>;
	metadata: Record<string, unknown>;
}

interface RuntimeOptions {
	serviceAvailable?: boolean;
	extracted?: { secrets: unknown[]; level?: string };
	extractionError?: unknown;
	setResult?: (key: string) => boolean | Error;
}

function createHarness(options: RuntimeOptions = {}) {
	const setCalls: SetCall[] = [];
	const promptCalls: Array<Record<string, unknown>> = [];
	const composedMessages: unknown[] = [];
	const callbacks: Array<Record<string, unknown>> = [];
	const service = {
		set: async (
			key: string,
			value: string,
			context: Record<string, unknown>,
			metadata: Record<string, unknown>,
		) => {
			setCalls.push({ key, value, context, metadata });
			const outcome = options.setResult?.(key) ?? true;
			if (outcome instanceof Error) {
				throw outcome;
			}
			return outcome;
		},
	};
	const runtime = {
		agentId: "agent-1",
		getService: () => (options.serviceAvailable === false ? null : service),
		composeState: async (message: unknown) => {
			composedMessages.push(message);
			return { composed: true };
		},
		dynamicPromptExecFromState: async (request: Record<string, unknown>) => {
			promptCalls.push(request);
			if (options.extractionError !== undefined) {
				throw options.extractionError;
			}
			return options.extracted ?? { secrets: [] };
		},
	};

	return {
		runtime,
		setCalls,
		promptCalls,
		composedMessages,
		callbacks,
		callback: async (response: Record<string, unknown>) => {
			callbacks.push(response);
			return [];
		},
	};
}

function createMessage(channelType: ChannelType | undefined = ChannelType.DM) {
	return {
		entityId: "user-1",
		roomId: "room-1",
		worldId: "world-1",
		content: { text: "set a secret", channelType },
	};
}

describe("SECRETS action=set", () => {
	test("refuses non-DM requests before resolving the service", async () => {
		const harness = createHarness({ serviceAvailable: false });

		const result = await setSecretHandler(
			harness.runtime as never,
			createMessage(ChannelType.GROUP) as never,
			undefined,
			undefined,
			harness.callback as never,
		);

		expect(result).toMatchObject({
			success: false,
			text: "Refused: secrets can only be set in DMs",
			data: { actionName: "SECRETS", action: "set" },
		});
		expect(harness.promptCalls).toHaveLength(0);
		expect(harness.callbacks).toEqual([
			expect.objectContaining({ action: "SECRETS" }),
		]);
		expect(harness.callbacks[0]?.text).toMatch(/direct message/i);
	});

	test("reports an unavailable secrets service without composing state", async () => {
		const harness = createHarness({ serviceAvailable: false });

		const result = await setSecretHandler(
			harness.runtime as never,
			createMessage() as never,
		);

		expect(result.success).toBe(false);
		expect(result.text).toContain("service is unavailable");
		expect(harness.composedMessages).toHaveLength(0);
		expect(harness.promptCalls).toHaveLength(0);
	});

	test("composes missing state and translates extraction errors", async () => {
		const harness = createHarness({ extractionError: new Error("model down") });
		const message = createMessage();

		const result = await setSecretHandler(
			harness.runtime as never,
			message as never,
		);

		expect(result.success).toBe(false);
		expect(result.text).toContain("Failed to extract secrets");
		expect(harness.composedMessages).toEqual([message]);
		expect(harness.setCalls).toHaveLength(0);
	});

	test("filters malformed extraction results and reports an empty request", async () => {
		const harness = createHarness({
			extracted: {
				secrets: [
					null,
					"token",
					{},
					{ key: "ONLY_KEY" },
					{ value: "only-value" },
				],
			},
		});

		const result = await setSecretHandler(
			harness.runtime as never,
			createMessage() as never,
			{ supplied: true } as never,
		);

		expect(result.success).toBe(false);
		expect(result.text).toContain("No secrets found");
		expect(harness.composedMessages).toHaveLength(0);
		expect(harness.setCalls).toHaveLength(0);
	});

	test("prefers structured secrets and level over extracted model values", async () => {
		const harness = createHarness({
			extracted: {
				secrets: [{ key: "MODEL_KEY", value: "model-value" }],
				level: "global",
			},
		});
		const structured: SecretInput[] = [
			{
				key: "my api-key",
				value: "structured-value",
				description: "User API key",
				type: "api_key",
			},
		];

		const result = await setSecretHandler(
			harness.runtime as never,
			createMessage() as never,
			{ supplied: true } as never,
			{ parameters: { secrets: structured, level: "user" } } as never,
			harness.callback as never,
		);

		expect(harness.promptCalls).toHaveLength(1);
		expect(harness.promptCalls[0]).toMatchObject({
			state: { supplied: true },
			options: {
				modelType: ModelType.TEXT_SMALL,
				contextCheckLevel: 0,
				maxRetries: 1,
			},
		});
		expect(harness.setCalls).toEqual([
			{
				key: "MY_API_KEY",
				value: "structured-value",
				context: {
					level: "user",
					agentId: "agent-1",
					worldId: undefined,
					userId: "user-1",
					requesterId: "user-1",
				},
				metadata: {
					type: "api_key",
					description: "User API key",
					validationMethod: "none",
					encrypted: true,
				},
			},
		]);
		expect(result).toMatchObject({
			success: true,
			text: "I've securely stored your MY_API_KEY. It's now available for use.",
			userFacingText:
				"I've securely stored your MY_API_KEY. It's now available for use.",
			verifiedUserFacing: true,
			turnComplete: true,
			data: {
				results: [{ key: "MY_API_KEY", success: true }],
			},
		});
		expect(harness.callbacks).toEqual([
			{
				text: "I've securely stored your MY_API_KEY. It's now available for use.",
				action: "SECRETS",
			},
		]);
	});

	test("uses the world context and default metadata for extracted secrets", async () => {
		const harness = createHarness({
			extracted: {
				secrets: [{ key: "openai_api_key", value: "sk-observed" }],
				level: "world",
			},
		});

		await setSecretHandler(harness.runtime as never, createMessage() as never);

		expect(harness.setCalls[0]).toMatchObject({
			key: "OPENAI_API_KEY",
			context: {
				level: "world",
				worldId: "world-1",
				userId: undefined,
			},
			metadata: {
				type: "secret",
				description: "Secret set via conversation",
				validationMethod: "api_key:openai",
				encrypted: true,
			},
		});
	});

	test("preserves input order in a plural all-success response", async () => {
		const harness = createHarness({
			extracted: {
				secrets: [
					{ key: "first", value: "one" },
					{ key: "second", value: "two" },
				],
			},
		});

		const result = await setSecretHandler(
			harness.runtime as never,
			createMessage() as never,
		);

		expect(harness.setCalls.map(({ key }) => key)).toEqual(["FIRST", "SECOND"]);
		expect(result.success).toBe(true);
		expect(result.text).toBe(
			"I've securely stored 2 secrets: FIRST, SECOND. They're now available for use.",
		);
	});

	test("reports total write failure and retains thrown error details", async () => {
		const harness = createHarness({
			extracted: { secrets: [{ key: "broken", value: "value" }] },
			setResult: () => new Error("vault unavailable"),
		});

		const result = await setSecretHandler(
			harness.runtime as never,
			createMessage() as never,
			undefined,
			undefined,
			harness.callback as never,
		);

		expect(result).toMatchObject({
			success: false,
			turnComplete: false,
			data: {
				results: [
					{ key: "BROKEN", success: false, error: "vault unavailable" },
				],
			},
		});
		expect(result.text).toBe(
			"I wasn't able to store the secret(s). BROKEN: vault unavailable",
		);
		expect(harness.callbacks[0]?.text).toBe(result.text);
	});

	test("aggregates mixed service outcomes without dropping later writes", async () => {
		const harness = createHarness({
			extracted: {
				secrets: [
					{ key: "saved", value: "one" },
					{ key: "rejected", value: "two" },
					{ key: "also saved", value: "three" },
				],
			},
			setResult: (key) => key !== "REJECTED",
		});

		const result = await setSecretHandler(
			harness.runtime as never,
			createMessage() as never,
		);

		expect(harness.setCalls.map(({ key }) => key)).toEqual([
			"SAVED",
			"REJECTED",
			"ALSO_SAVED",
		]);
		expect(result.success).toBe(true);
		expect(result.turnComplete).toBe(true);
		expect(result.text).toBe(
			"I stored 2 secret(s) (SAVED, ALSO_SAVED), but 1 failed (REJECTED).",
		);
		expect(result.data.results).toEqual([
			{ key: "SAVED", success: true },
			{ key: "REJECTED", success: false },
			{ key: "ALSO_SAVED", success: true },
		]);
	});
});
