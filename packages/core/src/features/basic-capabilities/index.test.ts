/**
 * Behavioural coverage for the basic-capabilities bundle entry point: the
 * `shouldRespond` response-gate decision table, the `fetchMediaData` URL
 * policy, the empty-input guard of `processAttachments`, and the
 * `createBasicCapabilitiesPlugin` config matrix that assembles the Plugin the
 * runtime registers. Deterministic unit harness — plain-object runtime fakes,
 * no database, no network, no module mocks.
 */
import { describe, expect, it } from "vitest";
import { TURN_CONTROL_ROUTES } from "../../runtime/turn-routes.ts";
import { EventType } from "../../types/events.ts";
import type { IAgentRuntime, Memory, Room } from "../../types/index.ts";
import { MESSAGE_SOURCE_CLIENT_CHAT } from "../../types/message-source.ts";
import { ChannelType, type MentionContext } from "../../types/primitives.ts";
import {
	advancedActions,
	advancedEvaluators,
	advancedProviders,
	advancedServices,
} from "../advanced-capabilities/index.ts";
import { autonomyRoutes } from "../autonomy/routes.ts";
import { CHANNEL_TOPICS_ROUTES } from "./channel-topics-routes.ts";
import {
	basicActions,
	basicEvaluators,
	basicProviders,
	basicServices,
	createBasicCapabilitiesPlugin,
	fetchMediaData,
	processAttachments,
	shouldRespond,
} from "./index.ts";

function fakeRuntime(settings: Record<string, string> = {}): IAgentRuntime {
	return {
		getSetting: (key: string) => settings[key],
		character: { name: "Alice", username: "alice_bot" },
	} as unknown as IAgentRuntime;
}

function roomOfType(type: string): Room {
	return { type } as unknown as Room;
}

function message(text?: string, source?: string): Memory {
	return { content: { text, source } } as unknown as Memory;
}

function mention(flags: Partial<MentionContext>): MentionContext {
	return { isMention: false, isReply: false, isThread: false, ...flags };
}

const BASE_ROUTES_LENGTH =
	TURN_CONTROL_ROUTES.length + CHANNEL_TOPICS_ROUTES.length;

describe("shouldRespond", () => {
	it("defers without a room context and skips evaluation entirely", () => {
		const result = shouldRespond(fakeRuntime(), message("hello"));
		expect(result).toEqual({
			shouldRespond: false,
			skipEvaluation: true,
			reason: "no room context",
		});
	});

	it("always responds in private channels without LLM evaluation", () => {
		for (const type of [
			ChannelType.DM,
			ChannelType.VOICE_DM,
			ChannelType.SELF,
			ChannelType.API,
		]) {
			const result = shouldRespond(
				fakeRuntime(),
				message("any text"),
				roomOfType(type),
			);
			expect(result.shouldRespond).toBe(true);
			expect(result.skipEvaluation).toBe(true);
			expect(result.reason).toBe(`private channel: ${type.toLowerCase()}`);
		}
	});

	it("matches private channel types case-insensitively", () => {
		const result = shouldRespond(
			fakeRuntime(),
			message("hi"),
			roomOfType("dM"),
		);
		expect(result.shouldRespond).toBe(true);
		expect(result.reason).toBe("private channel: dm");
	});

	it("defers unaddressed group messages to LLM evaluation", () => {
		const result = shouldRespond(
			fakeRuntime(),
			message("anyone here?"),
			roomOfType(ChannelType.GROUP),
		);
		expect(result).toEqual({
			shouldRespond: false,
			skipEvaluation: false,
			reason: "needs LLM evaluation",
		});
	});

	it("always responds to client_chat sources", () => {
		const result = shouldRespond(
			fakeRuntime(),
			message("gm", MESSAGE_SOURCE_CLIENT_CHAT),
			roomOfType(ChannelType.GROUP),
		);
		expect(result.shouldRespond).toBe(true);
		expect(result.skipEvaluation).toBe(true);
		expect(result.reason).toBe(
			`whitelisted source: ${MESSAGE_SOURCE_CLIENT_CHAT}`,
		);
	});

	it("always responds to platform mentions and replies", () => {
		const group = roomOfType(ChannelType.GROUP);
		const mentioned = shouldRespond(
			fakeRuntime(),
			message("hey"),
			group,
			mention({ isMention: true }),
		);
		expect(mentioned.shouldRespond).toBe(true);
		expect(mentioned.skipEvaluation).toBe(true);
		expect(mentioned.reason).toBe("platform mention");

		const replied = shouldRespond(
			fakeRuntime(),
			message("hey"),
			group,
			mention({ isReply: true }),
		);
		expect(replied.shouldRespond).toBe(true);
		expect(replied.reason).toBe("platform reply");
	});

	it("treats a platform mention as a mention when both flags are set", () => {
		const result = shouldRespond(
			fakeRuntime(),
			message("hey"),
			roomOfType(ChannelType.GROUP),
			mention({ isMention: true, isReply: true }),
		);
		expect(result.reason).toBe("platform mention");
	});

	it("responds when tagged text addresses the agent by name or username", () => {
		const group = roomOfType(ChannelType.GROUP);
		for (const text of ["@alice_bot good morning", "hey @Alice!"]) {
			const result = shouldRespond(fakeRuntime(), message(text), group);
			expect(result.shouldRespond).toBe(true);
			expect(result.skipEvaluation).toBe(true);
			expect(result.reason).toBe("text address with tagged participants");
		}
	});

	it("does not treat an untagged name as an address", () => {
		const result = shouldRespond(
			fakeRuntime(),
			message("alice_bot good morning"),
			roomOfType(ChannelType.GROUP),
		);
		expect(result.shouldRespond).toBe(false);
		expect(result.reason).toBe("needs LLM evaluation");
	});

	it("ignores tags that address someone else", () => {
		const result = shouldRespond(
			fakeRuntime(),
			message("hey @bob_builder look at this"),
			roomOfType(ChannelType.GROUP),
		);
		expect(result.shouldRespond).toBe(false);
		expect(result.reason).toBe("needs LLM evaluation");
	});

	it("honors custom always-respond channels from settings, brackets optional", () => {
		const bracketed = fakeRuntime({ ALWAYS_RESPOND_CHANNELS: "[telegram]" });
		const result = shouldRespond(
			bracketed,
			message("gm"),
			roomOfType("telegram"),
		);
		expect(result.shouldRespond).toBe(true);
		expect(result.skipEvaluation).toBe(true);
		expect(result.reason).toBe("private channel: telegram");

		const bare = fakeRuntime({ ALWAYS_RESPOND_CHANNELS: "telegram, slack" });
		expect(
			shouldRespond(bare, message("gm"), roomOfType("slack")).shouldRespond,
		).toBe(true);
	});

	it("falls back to SHOULD_RESPOND_BYPASS_TYPES only when the primary setting is unset", () => {
		const fallback = fakeRuntime({ SHOULD_RESPOND_BYPASS_TYPES: "telegram" });
		expect(
			shouldRespond(fallback, message("gm"), roomOfType("telegram"))
				.shouldRespond,
		).toBe(true);

		const bothSet = fakeRuntime({
			ALWAYS_RESPOND_CHANNELS: "slack",
			SHOULD_RESPOND_BYPASS_TYPES: "telegram",
		});
		expect(
			shouldRespond(bothSet, message("gm"), roomOfType("telegram"))
				.shouldRespond,
		).toBe(false);
		expect(
			shouldRespond(bothSet, message("gm"), roomOfType("slack")).shouldRespond,
		).toBe(true);
	});

	it("honors custom always-respond sources the same way", () => {
		const primary = fakeRuntime({ ALWAYS_RESPOND_SOURCES: "discord" });
		const result = shouldRespond(
			primary,
			message("gm", "discord"),
			roomOfType(ChannelType.GROUP),
		);
		expect(result.shouldRespond).toBe(true);
		expect(result.reason).toBe("whitelisted source: discord");

		const fallbackOnly = fakeRuntime({
			SHOULD_RESPOND_BYPASS_SOURCES: "irc",
		});
		expect(
			shouldRespond(
				fallbackOnly,
				message("gm", "irc"),
				roomOfType(ChannelType.GROUP),
			).shouldRespond,
		).toBe(true);
	});

	it("treats an empty custom list as unset instead of crashing", () => {
		const result = shouldRespond(
			fakeRuntime({ ALWAYS_RESPOND_CHANNELS: "" }),
			message("gm"),
			roomOfType(ChannelType.GROUP),
		);
		expect(result.shouldRespond).toBe(false);
	});
});

describe("fetchMediaData", () => {
	it("rejects local paths because only http(s) URLs are fetchable", async () => {
		await expect(
			fetchMediaData([{ id: "m1", url: "media/uploads/pic.png" }]),
		).rejects.toThrow(/File not found: media\/uploads\/pic\.png/);
	});

	it("rejects non-http URL schemes such as ftp", async () => {
		await expect(
			fetchMediaData([{ id: "m2", url: "ftp://host/file.png" }]),
		).rejects.toThrow(/File not found/);
	});
});

describe("processAttachments", () => {
	it("returns an empty array for null, undefined, and empty inputs", async () => {
		const runtime = fakeRuntime();
		await expect(processAttachments(null, runtime)).resolves.toEqual([]);
		await expect(processAttachments(undefined, runtime)).resolves.toEqual([]);
		await expect(processAttachments([], runtime)).resolves.toEqual([]);
	});
});

describe("createBasicCapabilitiesPlugin", () => {
	it("assembles the full basic bundle plus base routes by default", () => {
		const plugin = createBasicCapabilitiesPlugin();
		expect(plugin.name).toBe("basic-capabilities");
		expect(plugin.description).toBe(
			"Agent basic capabilities with core actions",
		);
		expect(plugin.actions?.length).toBe(basicActions.length);
		expect(plugin.providers?.length).toBe(basicProviders.length);
		expect(plugin.evaluators?.length).toBe(basicEvaluators.length);
		expect(plugin.services?.length).toBe(basicServices.length);
		expect(plugin.routes?.length).toBe(BASE_ROUTES_LENGTH);
		expect(
			plugin.providers?.some((provider) => provider.name === "CHARACTER"),
		).toBe(true);
		expect(typeof plugin.dispose).toBe("function");
		expect(plugin.init).toBeUndefined();
	});

	it("exposes lifecycle event handlers on the assembled plugin", () => {
		const plugin = createBasicCapabilitiesPlugin();
		expect(
			Array.isArray(plugin.events?.[EventType.MESSAGE_RECEIVED]) &&
				plugin.events[EventType.MESSAGE_RECEIVED].length > 0,
		).toBe(true);
		expect(
			Array.isArray(plugin.events?.[EventType.REACTION_RECEIVED]) &&
				plugin.events[EventType.REACTION_RECEIVED].length > 0,
		).toBe(true);
	});

	it("disableBasic strips every basic bundle while keeping base routes", () => {
		const plugin = createBasicCapabilitiesPlugin({ disableBasic: true });
		expect(plugin.actions).toEqual([]);
		expect(plugin.providers).toEqual([]);
		expect(plugin.evaluators).toEqual([]);
		expect(plugin.services).toEqual([]);
		expect(plugin.routes?.length).toBe(BASE_ROUTES_LENGTH);
	});

	it("skipCharacterProvider drops exactly the CHARACTER provider", () => {
		const plugin = createBasicCapabilitiesPlugin({
			skipCharacterProvider: true,
		});
		expect(plugin.providers?.length).toBe(basicProviders.length - 1);
		expect(
			plugin.providers?.some((provider) => provider.name === "CHARACTER"),
		).toBe(false);
	});

	it("enableExtended adds the complete advanced bundles", () => {
		const extended = createBasicCapabilitiesPlugin({ enableExtended: true });
		expect(extended.actions?.length).toBe(
			basicActions.length + advancedActions.length,
		);
		expect(extended.providers?.length).toBe(
			basicProviders.length + advancedProviders.length,
		);
		expect(extended.evaluators?.length).toBe(
			basicEvaluators.length + advancedEvaluators.length,
		);
		expect(extended.services?.length).toBe(
			basicServices.length + advancedServices.length,
		);
	});

	it("advancedCapabilities is an alias that produces the same shape", () => {
		const viaAlias = createBasicCapabilitiesPlugin({
			advancedCapabilities: true,
		});
		const viaFlag = createBasicCapabilitiesPlugin({ enableExtended: true });
		expect(viaAlias.actions?.length).toBe(viaFlag.actions?.length);
		expect(viaAlias.providers?.length).toBe(viaFlag.providers?.length);
		expect(viaAlias.services?.length).toBe(viaFlag.services?.length);
	});

	it("enableAutonomy adds exactly the autonomy bundle and its routes", () => {
		const plugin = createBasicCapabilitiesPlugin({ enableAutonomy: true });
		expect(plugin.actions?.length).toBe(basicActions.length + 3);
		expect(plugin.providers?.length).toBe(basicProviders.length + 2);
		expect(plugin.services?.length).toBe(basicServices.length + 1);
		expect(plugin.routes?.length).toBe(
			BASE_ROUTES_LENGTH + autonomyRoutes.length,
		);
	});

	it("enableTrust installs an init hook that the default config omits", () => {
		const plugin = createBasicCapabilitiesPlugin({ enableTrust: true });
		expect(typeof plugin.init).toBe("function");
	});
});
