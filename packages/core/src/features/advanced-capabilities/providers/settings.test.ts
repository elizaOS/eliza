/**
 * Unit tests for `settingsProvider` (advanced-capabilities): asserts the
 * room/world resolution gates (missing room, missing worldId, missing world,
 * unowned setup worlds, absent server ownership, absent settings state), the
 * DM setup lane's empty-settings initialization through `runtime.updateWorld`,
 * real at-rest secret decryption via `unsaltWorldSettings` (setup renders the
 * decrypted plaintext, read-only contexts render the 16-character mask while
 * `data.settings` still carries the decrypted value), required-vs-optional
 * checklist rendering with `state.senderName`, the "all configured" summary
 * paths in both modes, `visibleIf` hiding a setting from both the list and
 * the unconfigured-required count, and the `isSetting` guard skipping a
 * nested `settings` sub-record. Uses a hand-built deterministic runtime mock
 * — no live model, no DB; secrets are encrypted with the real
 * `encryptStringValue` under a fixed `SECRET_SALT`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearSaltCache,
	encryptStringValue,
	getSalt,
} from "../../../settings.ts";
import type {
	IAgentRuntime,
	Memory,
	Setting,
	State,
	UUID,
	World,
	WorldSettings,
} from "../../../types/index.ts";
import { ChannelType } from "../../../types/index.ts";
import { settingsProvider } from "./settings.ts";

const agentId = "00000000-0000-0000-0000-0000000000aa" as UUID;
const entityId = "00000000-0000-0000-0000-0000000000bb" as UUID;
const roomId = "00000000-0000-0000-0000-0000000000cc" as UUID;
const worldId = "00000000-0000-0000-0000-0000000000dd" as UUID;
const serverId = "00000000-0000-0000-0000-0000000000ee" as UUID;

const SECRET_PLAINTEXT = "sk-live-settings-provider-value";

function message(): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000001" as UUID,
		entityId,
		agentId,
		roomId,
		content: { text: "check my settings" },
	};
}

function setting(overrides: Partial<Setting> & { name: string }): Setting {
	return {
		description: "",
		usageDescription: "",
		required: false,
		value: null,
		dependsOn: [],
		...overrides,
	};
}

function ownedWorld(overrides: Partial<World> & { id: UUID }): World {
	return {
		agentId,
		metadata: { ownership: { ownerId: entityId } },
		...overrides,
	};
}

function makeRuntime(args: {
	room?: Record<string, unknown> | null;
	worlds?: World[] | null;
	world?: World | null;
}): IAgentRuntime & {
	getRoom: ReturnType<typeof vi.fn>;
	getAllWorlds: ReturnType<typeof vi.fn>;
	getWorld: ReturnType<typeof vi.fn>;
	updateWorld: ReturnType<typeof vi.fn>;
	reportError: ReturnType<typeof vi.fn>;
} {
	const runtime = {
		agentId,
		character: { name: "Eliza", bio: "", system: "" },
		getRoom: vi.fn(async () => args.room ?? null),
		getAllWorlds: vi.fn(async () => args.worlds ?? []),
		getWorld: vi.fn(async () => args.world ?? null),
		updateWorld: vi.fn(async () => true),
		reportError: vi.fn(),
	};
	return runtime as unknown as IAgentRuntime & {
		getRoom: ReturnType<typeof vi.fn>;
		getAllWorlds: ReturnType<typeof vi.fn>;
		getWorld: ReturnType<typeof vi.fn>;
		updateWorld: ReturnType<typeof vi.fn>;
		reportError: ReturnType<typeof vi.fn>;
	};
}

describe("settingsProvider resolution gates", () => {
	beforeEach(() => {
		process.env.SECRET_SALT = "settings-provider-test-salt";
		clearSaltCache();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.SECRET_SALT;
		clearSaltCache();
	});

	it("reports an explicit error when the room cannot be resolved", async () => {
		const runtime = makeRuntime({ room: null });

		const result = await settingsProvider.get(runtime, message());

		expect(result.text).toBe("Error: Room not found");
		expect(result.values?.settings).toBe("Error: Room not found");
		expect(result.data?.settings).toEqual([]);
	});

	it("skips rendering when the room has no worldId", async () => {
		const runtime = makeRuntime({
			room: { id: roomId, type: ChannelType.GROUP },
		});

		const result = await settingsProvider.get(runtime, message());

		expect(result.text).toBe(
			"Room does not have a worldId -- settings provider will be skipped",
		);
		expect(runtime.getWorld).not.toHaveBeenCalled();
	});

	it("degrades to unavailable and reports when the room's world is missing", async () => {
		const runtime = makeRuntime({
			room: { id: roomId, type: ChannelType.GROUP, worldId },
			world: null,
		});

		const result = await settingsProvider.get(runtime, message());

		expect(result.text).toBe("Configuration is temporarily unavailable.");
		expect(result.data?.available).toBe(false);
		expect(result.data?.error).toContain(`No world found for room ${worldId}`);
		expect(runtime.reportError).toHaveBeenCalledTimes(1);
		const [scope, error, context] = runtime.reportError.mock.calls[0];
		expect(scope).toBe("SettingsProvider.get");
		expect((error as Error).message).toContain(
			`No world found for room ${worldId}`,
		);
		expect(context).toEqual({ roomId });
	});

	it("skips setup when the user owns no worlds", async () => {
		const runtime = makeRuntime({
			room: { id: roomId, type: ChannelType.DM, worldId },
			worlds: [],
		});

		const result = await settingsProvider.get(runtime, message());

		expect(result.text).toBe(
			"No setup world found for the user -- settings provider will be skipped",
		);
	});

	it("does not treat another user's world as an owned setup world", async () => {
		const otherEntityId = "00000000-0000-0000-0000-0000000000ff" as UUID;
		const foreignWorld = ownedWorld({
			id: worldId,
			messageServerId: serverId,
			metadata: {
				ownership: { ownerId: otherEntityId },
				settings: { settings: {} } as WorldSettings,
			},
		});
		const runtime = makeRuntime({
			room: { id: roomId, type: ChannelType.DM, worldId },
			worlds: [foreignWorld],
		});

		const result = await settingsProvider.get(runtime, message());

		expect(result.text).toBe(
			"No setup world found for the user -- settings provider will be skipped",
		);
	});

	it("initializes an empty settings block on the first owned world during setup and renders the empty summary", async () => {
		const world = ownedWorld({ id: worldId, messageServerId: serverId });
		const runtime = makeRuntime({
			room: { id: roomId, type: ChannelType.DM, worldId },
			worlds: [world],
		});

		const result = await settingsProvider.get(runtime, message());

		expect(runtime.updateWorld).toHaveBeenCalledTimes(1);
		const persisted = runtime.updateWorld.mock.calls[0][0] as World;
		expect(persisted.id).toBe(worldId);
		expect(persisted.metadata?.settings).toEqual({ settings: {} });
		expect(
			result.text?.startsWith("All required settings have been configured."),
		).toBe(true);
		expect(result.text).toContain("Valid setting keys: settings");
	});
});

describe("settingsProvider state availability branches", () => {
	beforeEach(() => {
		process.env.SECRET_SALT = "settings-provider-test-salt";
		clearSaltCache();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.SECRET_SALT;
		clearSaltCache();
	});

	it("tells the user they own no servers during setup when the world has no serverId", async () => {
		const world = ownedWorld({
			id: worldId,
			metadata: {
				ownership: { ownerId: entityId },
				settings: { settings: {} } as WorldSettings,
			},
		});
		const runtime = makeRuntime({
			room: { id: roomId, type: ChannelType.DM, worldId },
			worlds: [world],
		});

		const result = await settingsProvider.get(runtime, message());

		expect(result.text).toBe(
			"The user doesn't appear to have ownership of any servers. They should make sure they're using the correct account.",
		);
	});

	it("reports no configuration access outside setup when the world lacks a serverId and settings", async () => {
		const world = ownedWorld({ id: worldId });
		const runtime = makeRuntime({
			room: { id: roomId, type: ChannelType.GROUP, worldId },
			world,
		});

		const result = await settingsProvider.get(runtime, message());

		expect(result.text).toBe("Error: No configuration access");
	});

	it("reports incomplete configuration outside setup when only the serverId exists", async () => {
		const world = ownedWorld({ id: worldId, messageServerId: serverId });
		const runtime = makeRuntime({
			room: { id: roomId, type: ChannelType.GROUP, worldId },
			world,
		});

		const result = await settingsProvider.get(runtime, message());

		expect(result.text).toBe("Configuration has not been completed yet.");
	});
});

describe("settingsProvider prompt rendering", () => {
	beforeEach(() => {
		process.env.SECRET_SALT = "settings-provider-test-salt";
		clearSaltCache();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.SECRET_SALT;
		clearSaltCache();
	});

	function flatSettings(): WorldSettings {
		return {
			API_KEY: setting({
				name: "API Key",
				usageDescription: "Server API key used for upstream calls",
				required: true,
				value: encryptStringValue(SECRET_PLAINTEXT, getSalt()),
				secret: true,
			}),
			REGION: setting({
				name: "Region",
				usageDescription: "Deployment region for the server",
				required: true,
			}),
			MODEL: setting({
				name: "Model",
				description: "Which model tier to use",
				usageDescription: "Pick small or large",
				value: "large",
			}),
		};
	}

	it("renders a read-only summary that masks the decrypted secret and counts unconfigured required settings", async () => {
		const world = ownedWorld({
			id: worldId,
			messageServerId: serverId,
			metadata: { ownership: { ownerId: entityId }, settings: flatSettings() },
		});
		const runtime = makeRuntime({
			room: { id: roomId, type: ChannelType.GROUP, worldId },
			world,
		});

		const result = await settingsProvider.get(runtime, message());

		expect(result.text?.startsWith("## Current Configuration")).toBe(true);
		expect(result.text).toContain(
			"IMPORTANT!: 1 required settings still need configuration. Eliza should complete setup with the OWNER as soon as possible.",
		);
		expect(result.text).toContain("**Value:** large");
		expect(result.text).toContain("**Value:** Not set");
		expect(result.text).not.toContain(SECRET_PLAINTEXT);
		expect(result.text).toContain("**Value:** ****************");
		const dataSettings = result.data?.settings as WorldSettings;
		expect(dataSettings.API_KEY.value).toBe(SECRET_PLAINTEXT);
	});

	it("renders an all-configured read-only summary without the IMPORTANT banner", async () => {
		const settings = flatSettings();
		settings.API_KEY = setting({
			name: "API Key",
			required: true,
			value: SECRET_PLAINTEXT,
			secret: true,
		});
		settings.REGION = setting({
			name: "Region",
			required: true,
			value: "us-east",
		});
		settings.BOOLEAN_FLAG = setting({
			name: "Flag",
			value: true,
		});
		const world = ownedWorld({
			id: worldId,
			messageServerId: serverId,
			metadata: { ownership: { ownerId: entityId }, settings },
		});
		const runtime = makeRuntime({
			room: { id: roomId, type: ChannelType.GROUP, worldId },
			world,
		});

		const result = await settingsProvider.get(runtime, message());

		expect(result.text).toContain("All required settings are configured.");
		expect(result.text).not.toContain("IMPORTANT!");
		expect(result.text).toContain("**Value:** true");
	});

	it("hides a visibleIf-gated setting from the list and from the unconfigured count", async () => {
		const settings: WorldSettings = {
			HIDDEN_KEY: setting({
				name: "Hidden",
				required: true,
				visibleIf: () => false,
			}),
			DONE_KEY: setting({ name: "Done", value: "yes" }),
		};
		const world = ownedWorld({
			id: worldId,
			messageServerId: serverId,
			metadata: { ownership: { ownerId: entityId }, settings },
		});
		const runtime = makeRuntime({
			room: { id: roomId, type: ChannelType.GROUP, worldId },
			world,
		});

		const result = await settingsProvider.get(runtime, message());

		expect(result.text).toContain("All required settings are configured.");
		expect(result.text).not.toContain("Hidden");
	});

	it("drives the setup checklist with sender name, required markers, and UPDATE_SETTINGS instructions", async () => {
		const world = ownedWorld({
			id: worldId,
			messageServerId: serverId,
			metadata: { ownership: { ownerId: entityId }, settings: flatSettings() },
		});
		const runtime = makeRuntime({
			room: { id: roomId, type: ChannelType.DM, worldId },
			worlds: [world],
		});
		const state = { senderName: "Alice" } as unknown as State;

		const result = await settingsProvider.get(runtime, message(), state);

		expect(result.text?.startsWith("# PRIORITY TASK: Setup with Alice")).toBe(
			true,
		);
		expect(result.text).toContain(
			"needs to help the user configure 1 required settings:",
		);
		expect(result.text).toContain("(Required)");
		expect(result.text).toContain("(Optional)");
		expect(result.text).toContain("Valid setting keys: API_KEY, REGION, MODEL");
		expect(result.text).toContain("UPDATE_SETTINGS action");
		expect(result.text).toContain(
			"- Prioritize configuring required settings before optional ones.",
		);
		expect(result.text).toContain(SECRET_PLAINTEXT);
	});

	it("announces completion when every required setting is configured during setup", async () => {
		const settings = flatSettings();
		settings.API_KEY = setting({
			name: "API Key",
			required: true,
			value: SECRET_PLAINTEXT,
			secret: true,
		});
		settings.REGION = setting({
			name: "Region",
			required: true,
			value: "us-east",
		});
		const world = ownedWorld({
			id: worldId,
			messageServerId: serverId,
			metadata: { ownership: { ownerId: entityId }, settings },
		});
		const runtime = makeRuntime({
			room: { id: roomId, type: ChannelType.DM, worldId },
			worlds: [world],
		});

		const result = await settingsProvider.get(runtime, message());

		expect(
			result.text?.startsWith("All required settings have been configured."),
		).toBe(true);
		expect(result.text).toContain("(Optional)");
		expect(result.text).not.toContain("PRIORITY TASK");
	});

	it("skips non-Setting entries such as a nested settings sub-record", async () => {
		const world = ownedWorld({
			id: worldId,
			messageServerId: serverId,
			metadata: {
				ownership: { ownerId: entityId },
				settings: {
					settings: {
						NESTED_KEY: setting({ name: "Nested", required: true }),
					},
				} as WorldSettings,
			},
		});
		const runtime = makeRuntime({
			room: { id: roomId, type: ChannelType.GROUP, worldId },
			world,
		});

		const result = await settingsProvider.get(runtime, message());

		expect(result.text?.startsWith("## Current Configuration")).toBe(true);
		expect(result.text).toContain("All required settings are configured.");
		expect(result.text).not.toContain("Nested");
	});
});
