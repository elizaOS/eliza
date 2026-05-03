import { beforeAll, describe, expect, it } from "vitest";

type ActionInteractionSemantics = {
	suppressPostActionContinuation?: boolean;
	suppressActionResultClipboard?: boolean;
};

type DiscordPluginModule = typeof import("../index.ts");

let mod: DiscordPluginModule;
let plugin: DiscordPluginModule["default"];

beforeAll(async () => {
	mod = await import("../index.ts");
	plugin = mod.default;
}, 120_000);

describe("@elizaos/plugin-discord", () => {
	it("exports the plugin as default", () => {
		expect(mod.default).toBeDefined();
		expect(typeof mod.default).toBe("object");
	});

	describe("plugin registration contract", () => {
		it("has a name", () => {
			expect(typeof plugin.name).toBe("string");
			expect(plugin.name).toBe("discord");
		});

		it("has a description", () => {
			expect(typeof plugin.description).toBe("string");
			expect(plugin.description.length).toBeGreaterThan(0);
		});

		it("has an init function", () => {
			expect(typeof plugin.init).toBe("function");
		});

		it("has services array with DiscordService", () => {
			expect(Array.isArray(plugin.services)).toBe(true);
			expect(plugin.services?.length).toBeGreaterThan(0);
		});

		it("has routes array", () => {
			expect(Array.isArray(plugin.routes)).toBe(true);
		});

		it("has actions array with well-formed actions", () => {
			expect(Array.isArray(plugin.actions)).toBe(true);
			const actions = plugin.actions ?? [];
			expect(actions.length).toBeGreaterThan(0);

			for (const action of actions) {
				expect(typeof action.name).toBe("string");
				expect(action.name.length).toBeGreaterThan(0);
				expect(typeof action.handler).toBe("function");
				expect(typeof action.validate).toBe("function");
				expect(typeof action.description).toBe("string");
			}
		});

		it("has providers array with well-formed providers", () => {
			expect(Array.isArray(plugin.providers)).toBe(true);
			const providers = plugin.providers ?? [];
			expect(providers.length).toBeGreaterThan(0);

			for (const provider of providers) {
				expect(typeof provider.get).toBe("function");
			}
		});

		it("has tests array", () => {
			expect(Array.isArray(plugin.tests)).toBe(true);
		});

		it("includes expected action names", () => {
			const actionNames = plugin.actions?.map((a) => a.name);
			expect(actionNames).toContain("SEND_MESSAGE");
			expect(actionNames).toContain("SEND_DM");
			expect(actionNames).toContain("JOIN_CHANNEL");
			expect(actionNames).toContain("LEAVE_CHANNEL");
		});

		it("marks terminal side-effect actions as turn-owning and non-copyable", () => {
			const actions = new Map(
				plugin.actions?.map((action) => [action.name, action]),
			);
			const terminalActions = [
				"SEND_MESSAGE",
				"SEND_DM",
				"CREATE_POLL",
				"REACT_TO_MESSAGE",
				"PIN_MESSAGE",
				"UNPIN_MESSAGE",
				"EDIT_MESSAGE",
				"DELETE_MESSAGE",
				"JOIN_CHANNEL",
				"LEAVE_CHANNEL",
				"SETUP_CREDENTIALS",
			];

			for (const actionName of terminalActions) {
				const action = actions.get(actionName) as
					| ActionInteractionSemantics
					| undefined;
				expect(action, `${actionName} should be registered`).toBeDefined();
				expect(action?.suppressPostActionContinuation).toBe(true);
				expect(action?.suppressActionResultClipboard).toBe(true);
			}
		});

		it("keeps informational actions copyable by the runtime finalizer", () => {
			const actions = new Map(
				plugin.actions?.map((action) => [action.name, action]),
			);
			const informationalActions = [
				"READ_CHANNEL",
				"SEARCH_MESSAGES",
				"LIST_CHANNELS",
				"GET_USER_INFO",
				"SERVER_INFO",
				"SUMMARIZE_CONVERSATION",
				"TRANSCRIBE_MEDIA",
				"DOWNLOAD_MEDIA",
				"CHAT_WITH_ATTACHMENTS",
			];

			for (const actionName of informationalActions) {
				const action = actions.get(actionName) as
					| ActionInteractionSemantics
					| undefined;
				expect(action, `${actionName} should be registered`).toBeDefined();
				expect(action?.suppressActionResultClipboard).not.toBe(true);
			}
		});
	});

	describe("named exports", () => {
		it("exports DiscordService", () => {
			expect(mod.DiscordService).toBeDefined();
		});

		it("exports DISCORD_SERVICE_NAME constant", () => {
			expect(typeof mod.DISCORD_SERVICE_NAME).toBe("string");
		});

		it("exports permission utilities", () => {
			expect(typeof mod.getPermissionValues).toBe("function");
			expect(typeof mod.generateInviteUrl).toBe("function");
		});

		it("exports messaging utilities", () => {
			expect(typeof mod.escapeDiscordMarkdown).toBe("function");
			expect(typeof mod.chunkDiscordText).toBe("function");
			expect(typeof mod.truncateText).toBe("function");
			expect(typeof mod.stripDiscordFormatting).toBe("function");
		});

		it("exports allowlist utilities", () => {
			expect(typeof mod.normalizeDiscordAllowList).toBe("function");
			expect(typeof mod.validateMessageAllowed).toBe("function");
		});

		it("exports account management utilities", () => {
			expect(typeof mod.resolveDiscordToken).toBe("function");
			expect(typeof mod.normalizeAccountId).toBe("function");
			expect(typeof mod.isMultiAccountEnabled).toBe("function");
		});
	});
});
