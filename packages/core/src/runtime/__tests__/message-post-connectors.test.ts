import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { getMessageConnectorsWithHook } from "../../features/advanced-capabilities/actions/connectorActionUtils";
import { AgentRuntime } from "../../runtime";
import type { Character, Content, Memory, TargetInfo } from "../../types";

function makeRuntime(): AgentRuntime {
	return new AgentRuntime({
		character: {
			name: "Connector Test Agent",
			bio: "test",
			settings: {},
		} as Character,
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
	});
}

function makeTarget(source: string): TargetInfo {
	return {
		source,
		roomId: "00000000-0000-0000-0000-00000000000c" as TargetInfo["roomId"],
	};
}

describe("message and post connector registries", () => {
	it("registers message connectors with optional sendHandler and enumerates hook-only connectors", async () => {
		const runtime = makeRuntime();
		const sentMemory = {
			id: "00000000-0000-0000-0000-000000000101",
			entityId: "00000000-0000-0000-0000-000000000102",
			roomId: "00000000-0000-0000-0000-000000000103",
			content: { text: "sent" },
		} as Memory;
		const sendHandler = vi.fn(async () => sentMemory);
		const fetchMessages = vi.fn(async () => [] as Memory[]);

		runtime.registerMessageConnector({
			source: "chat",
			label: "Chat",
			sendHandler,
			fetchMessages,
			capabilities: ["send_message", "read_messages"],
			supportedTargetKinds: ["room"],
		});
		runtime.registerMessageConnector({
			source: "archive",
			label: "Archive",
			fetchMessages,
			capabilities: ["read_messages"],
		});

		expect(
			runtime.getMessageConnectors().map((connector) => connector.source),
		).toEqual(["archive", "chat"]);
		expect(
			getMessageConnectorsWithHook(runtime, "fetchMessages").map(
				(connector) => connector.source,
			),
		).toEqual(["archive", "chat"]);
		expect(getMessageConnectorsWithHook(runtime, "resolveTargets")).toEqual([]);

		const target = makeTarget("chat");
		const content: Content = { text: "hello", source: "chat" };
		await expect(runtime.sendMessageToTarget(target, content)).resolves.toBe(
			sentMemory,
		);
		expect(sendHandler).toHaveBeenCalledWith(runtime, target, content);
	});

	it("unregisterMessageConnector removes both connector metadata and send handler", async () => {
		const runtime = makeRuntime();
		const sendHandler = vi.fn(async () => undefined);

		runtime.registerMessageConnector({
			source: "chat",
			sendHandler,
			fetchMessages: async () => [],
		});

		expect(runtime.unregisterMessageConnector(" chat ")).toBe(true);
		expect(runtime.getMessageConnectors()).toEqual([]);
		await expect(
			runtime.sendMessageToTarget(makeTarget("chat"), { text: "after" }),
		).rejects.toThrow("No send handler registered for source: chat");
		expect(runtime.unregisterMessageConnector("chat")).toBe(false);
	});

	it("routes send handlers by source and accountId", async () => {
		const runtime = makeRuntime();
		const ownerHandler = vi.fn(async () => undefined);
		const teamHandler = vi.fn(async () => undefined);

		runtime.registerMessageConnector({
			source: "chat",
			accountId: "owner-account",
			label: "Chat Owner",
			sendHandler: ownerHandler,
		});
		runtime.registerMessageConnector({
			source: "chat",
			accountId: "team-account",
			label: "Chat Team",
			sendHandler: teamHandler,
		});

		const ownerTarget = {
			...makeTarget("chat"),
			accountId: "owner-account",
		};
		const teamTarget = {
			...makeTarget("chat"),
			accountId: "team-account",
		};
		const content: Content = { text: "hello", source: "chat" };

		await runtime.sendMessageToTarget(ownerTarget, content);
		await runtime.sendMessageToTarget(teamTarget, content);

		expect(ownerHandler).toHaveBeenCalledTimes(1);
		expect(ownerHandler).toHaveBeenCalledWith(runtime, ownerTarget, content);
		expect(teamHandler).toHaveBeenCalledTimes(1);
		expect(teamHandler).toHaveBeenCalledWith(runtime, teamTarget, content);
		expect(
			runtime
				.getMessageConnectors()
				.map((connector) => [connector.source, connector.accountId]),
		).toEqual([
			["chat", "owner-account"],
			["chat", "team-account"],
		]);
	});

	it("keeps legacy source-only send routing when accountId is omitted", async () => {
		const runtime = makeRuntime();
		const legacyHandler = vi.fn(async () => undefined);
		const target = makeTarget("chat");
		const content: Content = { text: "legacy", source: "chat" };

		runtime.registerSendHandler("chat", legacyHandler);

		await runtime.sendMessageToTarget(target, content);

		expect(legacyHandler).toHaveBeenCalledWith(runtime, target, content);
	});

	it("does not route from untrusted content metadata accountId", async () => {
		const runtime = makeRuntime();
		const accountHandler = vi.fn(async () => undefined);

		runtime.registerMessageConnector({
			source: "chat",
			accountId: "owner-account",
			sendHandler: accountHandler,
		});

		await expect(
			runtime.sendMessageToTarget(makeTarget("chat"), {
				text: "spoof",
				source: "chat",
				metadata: { accountId: "owner-account" },
			}),
		).rejects.toThrow("No send handler registered for source: chat");
		expect(accountHandler).not.toHaveBeenCalled();
	});

	it("registers post connectors and returns sorted clones from getPostConnectors", () => {
		const runtime = makeRuntime();
		const fetchFeed = vi.fn(async () => [] as Memory[]);

		runtime.registerPostConnector({
			source: "zeta",
			label: "Zeta",
			postHandler: async () => undefined,
		});
		runtime.registerPostConnector({
			source: "alpha",
			fetchFeed,
			capabilities: ["read_feed"],
			contexts: ["social_posting"],
			metadata: { aliases: ["a"] },
		});

		const connectors = runtime.getPostConnectors();
		expect(connectors.map((connector) => connector.source)).toEqual([
			"alpha",
			"zeta",
		]);
		expect(connectors[0]).toMatchObject({
			source: "alpha",
			label: "Alpha",
			capabilities: ["read_feed"],
			contexts: ["social_posting"],
			metadata: { aliases: ["a"] },
		});
		expect(connectors[1]).toMatchObject({
			source: "zeta",
			label: "Zeta",
			capabilities: ["post"],
		});

		connectors[0].capabilities.push("mutated");
		connectors[0].contexts.push("mutated");

		expect(runtime.getPostConnectors()[0].capabilities).toEqual(["read_feed"]);
		expect(runtime.getPostConnectors()[0].contexts).toEqual(["social_posting"]);
	});
});
