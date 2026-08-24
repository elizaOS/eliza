/**
 * Exercises SECRETS_UPDATE_SETTINGS (features/secrets/setup/action): the
 * DM-and-world validate gate, LLM extraction traversal, dependency and
 * validation gating, secrets-service persistence, world-metadata persistence,
 * and the three callback outcomes (SETTING_UPDATED, SETUP_COMPLETE,
 * SETTING_UPDATE_FAILED). Runtime, model extraction, and secrets service are
 * deterministic fakes; the real action performs all parsing, gating, and
 * persistence decisions.
 */

import { describe, expect, test } from "vitest";
import { ChannelType } from "../../../types/index";
import { updateSettingsAction } from "./action";
import type { SetupSetting } from "./config";

interface SetCall {
	key: string;
	value: string;
	context: Record<string, unknown>;
	metadata: Record<string, unknown>;
}

interface HarnessOptions {
	channelType?: ChannelType;
	room?: Record<string, unknown> | null;
	world?: Record<string, unknown> | null;
	settings?: Record<string, SetupSetting>;
	extraction?: unknown;
	extractionImpl?: () => unknown;
	withSecretsService?: boolean;
}

function setting(name: string, over: Partial<SetupSetting> = {}): SetupSetting {
	return {
		name,
		description: `${name} description`,
		usageDescription: `${name} usage`,
		secret: true,
		public: false,
		required: true,
		dependsOn: [],
		type: "api_key",
		value: null,
		...over,
	};
}

function defaultSettings(): Record<string, SetupSetting> {
	return {
		OPENAI_API_KEY: setting("OpenAI API Key"),
		ANTHROPIC_API_KEY: setting("Anthropic API Key"),
	};
}

function createHarness(options: HarnessOptions = {}) {
	const settings = options.settings ?? defaultSettings();
	const world =
		options.world !== undefined
			? options.world
			: { id: "world-1", metadata: { settings } };
	const room =
		options.room !== undefined
			? options.room
			: { id: "room-1", worldId: "world-1" };
	const setCalls: SetCall[] = [];
	const promptCalls: Array<Record<string, unknown>> = [];
	const updatedWorlds: Array<Record<string, unknown>> = [];
	const callbacks: Array<Record<string, unknown>> = [];
	const service = {
		set: async (
			key: string,
			value: string,
			context: Record<string, unknown>,
			metadata: Record<string, unknown>,
		) => {
			setCalls.push({ key, value, context, metadata });
			return true;
		},
	};
	const runtime = {
		agentId: "agent-1",
		getRoom: async () => room,
		getWorld: async () => world,
		getService: () => (options.withSecretsService === false ? null : service),
		updateWorld: async (updated: Record<string, unknown>) => {
			updatedWorlds.push(updated);
			return true;
		},
		dynamicPromptExecFromState: async (request: Record<string, unknown>) => {
			promptCalls.push(request);
			if (options.extractionImpl) {
				return options.extractionImpl();
			}
			return options.extraction ?? { updates: [] };
		},
	};

	return {
		runtime,
		settings,
		world,
		setCalls,
		promptCalls,
		updatedWorlds,
		callbacks,
		callback: async (response: Record<string, unknown>) => {
			callbacks.push(response);
			return [];
		},
	};
}

type Harness = ReturnType<typeof createHarness>;

function createMessage(channelType: ChannelType = ChannelType.DM) {
	return {
		entityId: "user-1",
		roomId: "room-1",
		content: { text: "here is my key", channelType },
	};
}

function createState() {
	return { text: "my openai key is sk-observed" };
}

async function runHandler(
	harness: Harness,
	message = createMessage(),
	state = createState(),
) {
	return updateSettingsAction.handler(
		harness.runtime as never,
		message as never,
		state as never,
		undefined,
		harness.callback as never,
	);
}

describe("SECRETS_UPDATE_SETTINGS validate", () => {
	test("rejects non-DM channels", async () => {
		const harness = createHarness();

		await expect(
			updateSettingsAction.validate(
				harness.runtime as never,
				createMessage(ChannelType.GROUP) as never,
			),
		).resolves.toBe(false);
	});

	test("returns false when the room is missing", async () => {
		const harness = createHarness({ room: null });

		await expect(
			updateSettingsAction.validate(
				harness.runtime as never,
				createMessage() as never,
			),
		).resolves.toBe(false);
	});

	test("returns false when the room has no world", async () => {
		const harness = createHarness({ room: { id: "room-1" } });

		await expect(
			updateSettingsAction.validate(
				harness.runtime as never,
				createMessage() as never,
			),
		).resolves.toBe(false);
	});

	test("returns false when the world is missing", async () => {
		const harness = createHarness({ world: null });

		await expect(
			updateSettingsAction.validate(
				harness.runtime as never,
				createMessage() as never,
			),
		).resolves.toBe(false);
	});

	test("returns false when the world has no settings metadata", async () => {
		const harness = createHarness({
			world: { id: "world-1", metadata: {} },
		});

		await expect(
			updateSettingsAction.validate(
				harness.runtime as never,
				createMessage() as never,
			),
		).resolves.toBe(false);
	});

	test("accepts a DM whose world still has an unset setting", async () => {
		const harness = createHarness();

		await expect(
			updateSettingsAction.validate(
				harness.runtime as never,
				createMessage() as never,
			),
		).resolves.toBe(true);
	});

	test("rejects when every setting already has a value", async () => {
		const harness = createHarness({
			settings: {
				OPENAI_API_KEY: setting("OpenAI API Key", { value: "sk-set" }),
				ANTHROPIC_API_KEY: setting("Anthropic API Key", {
					value: "sk-ant-set",
				}),
			},
		});

		await expect(
			updateSettingsAction.validate(
				harness.runtime as never,
				createMessage() as never,
			),
		).resolves.toBe(false);
	});

	test("treats an unset optional setting as still needing setup", async () => {
		const harness = createHarness({
			settings: {
				OPENAI_API_KEY: setting("OpenAI API Key", { value: "sk-set" }),
				ANTHROPIC_API_KEY: setting("Anthropic API Key", {
					required: false,
				}),
			},
		});

		await expect(
			updateSettingsAction.validate(
				harness.runtime as never,
				createMessage() as never,
			),
		).resolves.toBe(true);
	});
});

describe("SECRETS_UPDATE_SETTINGS handler", () => {
	test("fails fast without state or callback", async () => {
		const harness = createHarness();
		const message = createMessage();

		const withoutState = await updateSettingsAction.handler(
			harness.runtime as never,
			message as never,
			undefined,
			undefined,
			harness.callback as never,
		);
		const withoutCallback = await updateSettingsAction.handler(
			harness.runtime as never,
			message as never,
			createState() as never,
		);

		expect(withoutState).toMatchObject({
			text: "State and callback required",
			success: false,
			data: { actionName: "SECRETS_UPDATE_SETTINGS" },
		});
		expect(withoutCallback).toMatchObject({
			text: "State and callback required",
			success: false,
		});
		expect(harness.callbacks).toHaveLength(0);
		expect(harness.promptCalls).toHaveLength(0);
	});

	test("reports a missing room through the callback", async () => {
		const harness = createHarness({ room: null });

		const result = await runHandler(harness);

		expect(result).toMatchObject({
			text: "Room not found",
			success: false,
			data: { actionName: "SECRETS_UPDATE_SETTINGS" },
		});
		expect(harness.callbacks).toEqual([
			{ text: "Unable to find room configuration." },
		]);
	});

	test("reports a room without a world through the callback", async () => {
		const harness = createHarness({ room: { id: "room-1" } });

		const result = await runHandler(harness);

		expect(result.success).toBe(false);
		expect(harness.callbacks).toEqual([
			{ text: "Unable to find room configuration." },
		]);
	});

	test("reports a world without settings", async () => {
		const harness = createHarness({
			world: { id: "world-1", metadata: {} },
		});

		const result = await runHandler(harness);

		expect(result).toMatchObject({
			text: "No settings found",
			success: false,
		});
		expect(harness.callbacks).toEqual([
			{ text: "No settings configured for this world." },
		]);
		expect(harness.promptCalls).toHaveLength(0);
	});

	test("skips the model entirely when nothing is unconfigured", async () => {
		const harness = createHarness({
			settings: {
				OPENAI_API_KEY: setting("OpenAI API Key", { value: "sk-set" }),
				ANTHROPIC_API_KEY: setting("Anthropic API Key", {
					value: "sk-ant-set",
				}),
			},
			extractionImpl: () => {
				throw new Error("model must not run");
			},
		});

		const result = await runHandler(harness);

		expect(result).toMatchObject({
			success: false,
			data: {
				actionName: "SECRETS_UPDATE_SETTINGS",
				action: "SETTING_UPDATE_FAILED",
			},
		});
		expect(harness.promptCalls).toHaveLength(0);
		expect(harness.callbacks).toEqual([
			{
				text: "I couldn't extract any settings from your message. Could you try again?",
				actions: ["SETTING_UPDATE_FAILED"],
			},
		]);
	});

	test("stores the extracted value and prompts for the next required setting", async () => {
		const harness = createHarness({
			settings: {
				OPENAI_API_KEY: setting("OpenAI API Key", {
					validationMethod: "none",
				}),
				ANTHROPIC_API_KEY: setting("Anthropic API Key"),
			},
			extraction: {
				updates: [{ key: "OPENAI_API_KEY", value: "sk-observed" }],
			},
		});

		const result = await runHandler(harness);

		expect(harness.promptCalls).toHaveLength(1);
		const prompt = String(
			(harness.promptCalls[0]?.params as { prompt?: unknown })?.prompt ?? "",
		);
		expect(prompt).toContain("OPENAI_API_KEY");
		expect(prompt).toContain("my openai key is sk-observed");

		expect(harness.setCalls).toEqual([
			{
				key: "OPENAI_API_KEY",
				value: "sk-observed",
				context: {
					level: "world",
					agentId: "agent-1",
					worldId: "world-1",
					requesterId: "user-1",
				},
				metadata: {
					description: "OpenAI API Key description",
					type: "api_key",
					encrypted: true,
				},
			},
		]);
		expect(harness.updatedWorlds).toEqual([harness.world]);
		const persisted = (
			harness.world.metadata as { settings: Record<string, SetupSetting> }
		).settings?.OPENAI_API_KEY;
		expect(persisted?.value).toBe("sk-observed");

		expect(harness.callbacks).toEqual([
			{
				text: "Updated OpenAI API Key successfully\n\nNext, I need your Anthropic API Key. Anthropic API Key usage",
				actions: ["SETTING_UPDATED"],
			},
		]);
		expect(result).toMatchObject({
			success: true,
			values: { success: true, remainingRequired: 1 },
			data: {
				actionName: "SECRETS_UPDATE_SETTINGS",
				action: "SETTING_UPDATED",
				updated: ["OPENAI_API_KEY"],
			},
		});
	});

	test("announces setup completion when the last required setting lands", async () => {
		const harness = createHarness({
			settings: { OPENAI_API_KEY: setting("OpenAI API Key") },
			extraction: {
				updates: [{ key: "OPENAI_API_KEY", value: "sk-observed" }],
			},
		});

		const result = await runHandler(harness);

		expect(harness.callbacks).toEqual([
			{
				text: "Updated OpenAI API Key successfully\n\nAll required settings have been configured! You're all set.",
				actions: ["SETUP_COMPLETE"],
			},
		]);
		expect(result).toMatchObject({
			success: true,
			values: { success: true, firstRunComplete: true },
			data: {
				actionName: "SECRETS_UPDATE_SETTINGS",
				action: "SETUP_COMPLETE",
			},
		});
	});

	test("rejects values failing custom validation without persisting anything", async () => {
		const harness = createHarness({
			settings: {
				OPENAI_API_KEY: setting("OpenAI API Key", {
					validation: () => false,
				}),
			},
			extraction: {
				updates: [{ key: "OPENAI_API_KEY", value: "not-a-key" }],
			},
		});

		const result = await runHandler(harness);

		expect(harness.setCalls).toHaveLength(0);
		expect(harness.updatedWorlds).toHaveLength(0);
		expect(
			(harness.world.metadata as { settings: Record<string, SetupSetting> })
				.settings.OPENAI_API_KEY.value,
		).toBeNull();
		expect(harness.callbacks).toEqual([
			{
				text: "I couldn't understand that. I need your OpenAI API Key. OpenAI API Key usage",
				actions: ["SETTING_UPDATE_FAILED"],
			},
		]);
		expect(result.success).toBe(false);
	});

	test("aggregates mixed outcomes while preserving update order", async () => {
		const harness = createHarness({
			extraction: {
				updates: [
					{ key: "OPENAI_API_KEY", value: "sk-observed" },
					{ key: "ANTHROPIC_API_KEY", value: "not-a-key" },
				],
			},
		});
		harness.settings.ANTHROPIC_API_KEY.validation = () => false;

		const result = await runHandler(harness);

		expect(harness.setCalls.map(({ key }) => key)).toEqual(["OPENAI_API_KEY"]);
		expect(harness.callbacks[0]).toMatchObject({
			text:
				"Updated OpenAI API Key successfully\n" +
				"Invalid value for Anthropic API Key\n\n" +
				"Next, I need your Anthropic API Key. Anthropic API Key usage",
			actions: ["SETTING_UPDATED"],
		});
		expect(result).toMatchObject({
			success: true,
			values: { remainingRequired: 1 },
			data: { updated: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] },
		});
	});

	test("blocks updates whose dependencies are unmet", async () => {
		const harness = createHarness({
			settings: {
				TWITTER_PASSWORD: setting("Twitter Password", {
					dependsOn: ["TWITTER_USERNAME"],
				}),
			},
			extraction: {
				updates: [{ key: "TWITTER_PASSWORD", value: "secret123" }],
			},
		});

		const result = await runHandler(harness);

		expect(harness.setCalls).toHaveLength(0);
		expect(harness.updatedWorlds).toHaveLength(0);
		expect(harness.callbacks).toEqual([
			{
				text: "I couldn't extract any settings from your message. Could you try again?",
				actions: ["SETTING_UPDATE_FAILED"],
			},
		]);
		expect(result.success).toBe(false);
	});

	test("coerces numeric values and appends onSetAction output without a secrets service", async () => {
		const harness = createHarness({
			settings: {
				RATE_LIMIT: setting("Rate Limit", {
					onSetAction: (value) => `Rate limit recorded: ${String(value)}`,
				}),
			},
			extraction: { updates: [{ key: "RATE_LIMIT", value: 50 }] },
			withSecretsService: false,
		});

		const result = await runHandler(harness);

		expect(harness.setCalls).toHaveLength(0);
		expect(harness.updatedWorlds).toHaveLength(1);
		const stored = (
			harness.world.metadata as { settings: Record<string, SetupSetting> }
		).settings.RATE_LIMIT;
		expect(stored.value).toBe("50");
		expect(harness.callbacks).toEqual([
			{
				text: "Updated Rate Limit successfully\nRate limit recorded: 50\n\nAll required settings have been configured! You're all set.",
				actions: ["SETUP_COMPLETE"],
			},
		]);
		expect(result.values).toMatchObject({ firstRunComplete: true });
	});

	test("ignores extractions for unknown setting keys", async () => {
		const harness = createHarness({
			extraction: {
				updates: [{ key: "MYSTERY_KEY", value: "surprise" }],
			},
		});

		const result = await runHandler(harness);

		expect(harness.setCalls).toHaveLength(0);
		expect(harness.updatedWorlds).toHaveLength(0);
		expect(harness.callbacks).toEqual([
			{
				text: "I couldn't understand that. I need your OpenAI API Key. OpenAI API Key usage",
				actions: ["SETTING_UPDATE_FAILED"],
			},
		]);
		expect(result.success).toBe(false);
	});
});
