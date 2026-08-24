/**
 * Deterministic unit tests for the secrets setup providers
 * (features/secrets/setup): SETUP_SETTINGS injects setup status into LLM
 * context — prioritising unconfigured required settings in DM setup mode and
 * masking secret values outside it — while MISSING_SECRETS lists settings
 * that still need a value. Runs the real module against a hand-built mock
 * runtime — no live model or database.
 */
import { describe, expect, test } from "vitest";
import {
	createMockRuntime,
	MOCK_AGENT_ID,
} from "../../../testing/mock-runtime.ts";
import type {
	Character,
	IAgentRuntime,
	Memory,
	Room,
	State,
	UUID,
	World,
} from "../../../types/index.ts";
import { ChannelType } from "../../../types/index.ts";
import type { SetupSetting } from "./config.ts";
import { missingSecretsProvider, setupSettingsProvider } from "./provider.ts";

const ROOM_ID = "room-1" as UUID;
const WORLD_ID = "world-1" as UUID;

function makeSetting(overrides: Partial<SetupSetting> = {}): SetupSetting {
	return {
		name: "Test Setting",
		description: "A test setting",
		usageDescription: undefined,
		secret: true,
		public: false,
		required: true,
		dependsOn: [],
		value: null,
		...overrides,
	};
}

function dmRoom(): Room {
	return {
		id: ROOM_ID,
		source: "test",
		type: ChannelType.DM,
		worldId: WORLD_ID,
	};
}

function groupRoom(): Room {
	return { ...dmRoom(), type: ChannelType.GROUP };
}

function worldWith(metadata?: World["metadata"]): World {
	return { id: WORLD_ID, agentId: MOCK_AGENT_ID, metadata };
}

function runtimeFor(
	room: Room | null,
	world: World | null,
	character?: Character,
): IAgentRuntime {
	return createMockRuntime({
		...(character ? { character } : {}),
		getRoom: async () => room,
		getWorld: async () => world,
	});
}

function message(): Memory {
	return {
		agentId: MOCK_AGENT_ID,
		entityId: MOCK_AGENT_ID,
		roomId: ROOM_ID,
		content: { text: "setup status" },
	} as Memory;
}

describe("setupSettingsProvider", () => {
	test("returns an explicit error when the message room does not exist", async () => {
		const result = await setupSettingsProvider.get(
			runtimeFor(null, worldWith()),
			message(),
		);

		expect(result).toEqual({
			data: { settings: [] },
			values: { settings: "Error: Room not found" },
			text: "Error: Room not found",
		});
	});

	test("returns an explicit error when the room has no associated world", async () => {
		const result = await setupSettingsProvider.get(
			runtimeFor({ ...dmRoom(), worldId: undefined }, worldWith()),
			message(),
		);

		expect(result).toEqual({
			data: { settings: [] },
			values: { settings: "Room has no associated world." },
			text: "Room has no associated world.",
		});
	});

	test("returns an explicit error when the world does not exist", async () => {
		const result = await setupSettingsProvider.get(
			runtimeFor(dmRoom(), null),
			message(),
		);

		expect(result).toEqual({
			data: { settings: [] },
			values: { settings: "Error: World not found" },
			text: "Error: World not found",
		});
	});

	test("points at initializeSetup in DM mode when the world has no settings", async () => {
		const result = await setupSettingsProvider.get(
			runtimeFor(dmRoom(), worldWith({})),
			message(),
		);

		expect(result).toEqual({
			data: { settings: [] },
			values: {
				settings:
					"No settings configured for this world. Use initializeSetup to set up.",
			},
			text: "No settings configured for this world.",
		});
	});

	test("stays silent in non-setup contexts when the world has no settings", async () => {
		const result = await setupSettingsProvider.get(
			runtimeFor(groupRoom(), worldWith({})),
			message(),
		);

		expect(result).toEqual({
			data: { settings: [] },
			values: { settings: "" },
			text: "",
		});
	});

	test("prioritises unconfigured required settings in setup mode while listing every valid key", async () => {
		const settings = {
			OPENAI_API_KEY: makeSetting({
				name: "OpenAI API Key",
				description: "API key for OpenAI services",
				usageDescription: "Your key starts with sk-",
				required: true,
				value: null,
			}),
			HIDDEN_FLAG: makeSetting({
				name: "Hidden Flag",
				description: "Only shown when unlocked",
				required: false,
				secret: false,
				value: "on",
				visibleIf: () => false,
			}),
		};

		const result = await setupSettingsProvider.get(
			runtimeFor(dmRoom(), worldWith({ settings })),
			message(),
		);

		expect(result.text?.startsWith("# PRIORITY TASK: Setup with user")).toBe(
			true,
		);
		expect(result.text).toContain(
			"needs to help the user configure 1 required settings:",
		);
		expect(result.text).toContain("OPENAI_API_KEY: Not set (Required)");
		expect(result.text).toContain("(OpenAI API Key) Your key starts with sk-");
		expect(result.text).toContain(
			"Valid setting keys: OPENAI_API_KEY, HIDDEN_FLAG",
		);
		expect(result.text).toContain(
			"- Prioritize configuring required settings before optional ones.",
		);
		expect(result.text).not.toContain("Hidden Flag");
	});

	test("addresses the sender by name when state provides one", async () => {
		const settings = {
			REQ_ONE: makeSetting({ name: "Required One" }),
		};

		const result = await setupSettingsProvider.get(
			runtimeFor(dmRoom(), worldWith({ settings })),
			message(),
			{ senderName: "Alice" } as State,
		);

		expect(result.text?.startsWith("# PRIORITY TASK: Setup with Alice")).toBe(
			true,
		);
	});

	test("shows configured secret values inside DM setup mode", async () => {
		const settings = {
			SECRET_TOKEN: makeSetting({
				name: "Secret Token",
				description: "A private token",
				usageDescription: "Ask me nicely",
				required: false,
				value: "sk-live-123",
			}),
		};

		const result = await setupSettingsProvider.get(
			runtimeFor(dmRoom(), worldWith({ settings })),
			message(),
		);

		expect(
			result.text?.startsWith(
				"All required settings have been configured. Here's the current configuration:",
			),
		).toBe(true);
		expect(result.text).toContain("SECRET_TOKEN: sk-live-123 (Optional)");
		expect(result.text).toContain("(Secret Token) Ask me nicely");
	});

	test("resolves the agent name from the runtime character with an Agent fallback", async () => {
		const settings = {
			REQ_ONE: makeSetting({ name: "Required One" }),
		};

		const named = await setupSettingsProvider.get(
			runtimeFor(dmRoom(), worldWith({ settings }), { name: "SetupBot" }),
			message(),
		);
		expect(named.text).toContain("Instructions for SetupBot:");

		const anonymous = await setupSettingsProvider.get(
			runtimeFor(dmRoom(), worldWith({ settings }), { name: undefined }),
			message(),
		);
		expect(anonymous.text).toContain("Instructions for Agent:");
	});

	test("masks configured secrets outside setup while flagging missing required settings", async () => {
		const settings = {
			REQUIRED_UNSET: makeSetting({
				name: "Required Unset",
				description: "Still needed",
				required: true,
				secret: false,
				value: null,
			}),
			PUBLIC_LABEL: makeSetting({
				name: "Public Label",
				description: "Shown publicly",
				required: false,
				secret: false,
				value: "acme",
			}),
			SECRET_TOKEN: makeSetting({
				name: "Secret Token",
				description: "A private token",
				required: false,
				secret: true,
				value: "sk-secret-value",
			}),
		};

		const result = await setupSettingsProvider.get(
			runtimeFor(groupRoom(), worldWith({ settings })),
			message(),
		);

		expect(result.text?.startsWith("## Current Configuration")).toBe(true);
		expect(result.text).toContain(
			"IMPORTANT!: 1 required settings still need configuration. MockAgent should get onboarded with the OWNER as soon as possible.",
		);
		expect(result.text).toContain("**Value:** Not set");
		expect(result.text).toContain("**Value:** acme");
		expect(result.text).toContain("**Value:** ****************");
		expect(result.text).not.toContain("sk-secret-value");
	});

	test("reports full configuration outside setup without the priority banner", async () => {
		const settings = {
			DONE_KEY: makeSetting({
				name: "Done Key",
				description: "Already set",
				required: true,
				value: "yes",
			}),
		};

		const result = await setupSettingsProvider.get(
			runtimeFor(groupRoom(), worldWith({ settings })),
			message(),
		);

		expect(result.text).toContain("All required settings are configured.");
		expect(result.text).not.toContain("IMPORTANT!");
		expect(result.text).toContain("### Done Key");
	});
});

describe("missingSecretsProvider", () => {
	test("returns empty context when the room is missing or has no world id", async () => {
		for (const room of [null, { ...dmRoom(), worldId: undefined }]) {
			const result = await missingSecretsProvider.get(
				runtimeFor(room, worldWith()),
				message(),
			);

			expect(result).toEqual({
				data: { missing: [] },
				values: { missingSecrets: "" },
				text: "",
			});
		}
	});

	test("returns empty context when the world is missing or carries no settings", async () => {
		for (const world of [null, worldWith({})]) {
			const result = await missingSecretsProvider.get(
				runtimeFor(dmRoom(), world),
				message(),
			);

			expect(result).toEqual({
				data: { missing: [] },
				values: { missingSecrets: "" },
				text: "",
			});
		}
	});

	test("lists missing required and optional secrets with usageDescription falling back to description", async () => {
		const settings = {
			REQ_ONE: makeSetting({
				name: "OpenAI API Key",
				description: "API key for OpenAI services",
				usageDescription: "Provide the OpenAI key",
				required: true,
				value: null,
			}),
			OPT_ONE: makeSetting({
				name: "Telemetry Toggle",
				description: "Optional telemetry toggle",
				required: false,
				secret: false,
				value: null,
			}),
			DONE_KEY: makeSetting({
				name: "Done Key",
				description: "Already set",
				required: true,
				value: "set",
			}),
		};

		const result = await missingSecretsProvider.get(
			runtimeFor(dmRoom(), worldWith({ settings })),
			message(),
		);

		expect(result.text).toBe(
			"Missing required secrets:\n- REQ_ONE: Provide the OpenAI key\n\nMissing optional secrets:\n- OPT_ONE: Optional telemetry toggle",
		);
		expect(result.values).toEqual({
			missingSecrets:
				"Missing required secrets:\n- REQ_ONE: Provide the OpenAI key\n\nMissing optional secrets:\n- OPT_ONE: Optional telemetry toggle",
		});
		expect(result.data).toMatchObject({
			missingRequired: [
				{
					key: "REQ_ONE",
					name: "OpenAI API Key",
					description: "Provide the OpenAI key",
				},
			],
		});
		const data = result.data as { missing: unknown[] };
		expect(data.missing).toHaveLength(2);
	});

	test("reports full configuration when every secret has a value", async () => {
		const settings = {
			REQ_ONE: makeSetting({ name: "Required One", value: "set" }),
			OPT_ONE: makeSetting({
				name: "Optional One",
				required: false,
				secret: false,
				value: "set",
			}),
		};

		const result = await missingSecretsProvider.get(
			runtimeFor(dmRoom(), worldWith({ settings })),
			message(),
		);

		expect(result).toEqual({
			data: { missing: [] },
			values: { missingSecrets: "All secrets are configured." },
			text: "All secrets are configured.",
		});
	});

	test("lists only the optional section when every required secret is set", async () => {
		const settings = {
			REQ_ONE: makeSetting({ name: "Required One", value: "set" }),
			OPT_ONE: makeSetting({
				name: "Telemetry Toggle",
				description: "Optional telemetry toggle",
				required: false,
				secret: false,
				value: null,
			}),
		};

		const result = await missingSecretsProvider.get(
			runtimeFor(dmRoom(), worldWith({ settings })),
			message(),
		);

		expect(result.text).toBe(
			"Missing optional secrets:\n- OPT_ONE: Optional telemetry toggle",
		);
		expect(result.data).toMatchObject({ missingRequired: [] });
	});
});
