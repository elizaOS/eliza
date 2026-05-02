/**
 * Tests for DiscordOwnerPairingService and the /eliza-pair slash command.
 *
 * These tests are unit-level: they use in-process mocks for the backend
 * OWNER_BIND_VERIFY service, the discord.js Client, and IAgentRuntime.
 * No real Discord token or network calls are made.
 *
 * We import handleElizaPairCommand directly to avoid going through the
 * slash-commands module-singleton, which would require vi.resetModules()
 * between tests and trigger slow discord.js re-imports.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetRateLimitStateForTesting,
	DiscordOwnerPairingServiceImpl,
	handleElizaPairCommand,
} from "../owner-pairing-service";

// --------------------------------------------------------------------------
// Minimal runtime mock
// --------------------------------------------------------------------------

type ServiceMap = Map<string, unknown>;

function makeRuntime(services: ServiceMap = new Map()) {
	return {
		agentId: "test-agent",
		character: { name: "TestBot" },
		logger: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		},
		getService: vi.fn((serviceType: string) => services.get(serviceType)),
		getSetting: vi.fn(() => undefined),
		emitEvent: vi.fn().mockResolvedValue(undefined),
	};
}

// --------------------------------------------------------------------------
// Helpers to build minimal discord.js interaction mocks
// --------------------------------------------------------------------------

function makePairInteraction(
	userId: string,
	username: string,
	code: string | null,
	discriminator = "0",
) {
	return {
		user: {
			id: userId,
			username,
			discriminator,
			createDM: vi.fn(),
		},
		options: {
			getString: vi.fn((_name: string, _required?: boolean) => code),
		},
		reply: vi.fn().mockResolvedValue(undefined),
		followUp: vi.fn().mockResolvedValue(undefined),
		deferred: false,
		replied: false,
		commandName: "eliza-pair",
		channelId: "channel-1",
		guild: null,
		client: {},
	};
}

// --------------------------------------------------------------------------
// /eliza-pair command tests
// --------------------------------------------------------------------------

describe("Discord /eliza-pair slash command", () => {
	beforeEach(() => {
		// Clear rate-limit state between tests.
		_resetRateLimitStateForTesting();
	});

	it("replies with usage hint when code argument is absent", async () => {
		const runtime = makeRuntime();
		const interaction = makePairInteraction("111", "alice", null);

		await handleElizaPairCommand(interaction as never, runtime as never);

		expect(interaction.reply).toHaveBeenCalledOnce();
		const args = (interaction.reply as ReturnType<typeof vi.fn>).mock
			.calls[0][0] as { content: string; ephemeral?: boolean };
		expect(args.content).toContain("Usage");
		expect(args.ephemeral).toBe(true);
	});

	it("replies with success when backend returns { success: true }", async () => {
		const verifySvc = {
			verifyOwnerBindFromConnector: vi
				.fn()
				.mockResolvedValue({ success: true }),
		};
		const services: ServiceMap = new Map([["OWNER_BIND_VERIFY", verifySvc]]);
		const runtime = makeRuntime(services);
		const interaction = makePairInteraction("222", "bob", "482193");

		await handleElizaPairCommand(interaction as never, runtime as never);

		expect(verifySvc.verifyOwnerBindFromConnector).toHaveBeenCalledOnce();
		expect(verifySvc.verifyOwnerBindFromConnector).toHaveBeenCalledWith({
			connector: "discord",
			externalId: "222",
			displayHandle: "bob",
			code: "482193",
		});

		const replyCall = (interaction.reply as ReturnType<typeof vi.fn>).mock
			.calls[0][0] as { content: string };
		expect(replyCall.content).toMatch(/paired with eliza/i);
	});

	it("replies with failure message when backend returns { success: false }", async () => {
		const verifySvc = {
			verifyOwnerBindFromConnector: vi
				.fn()
				.mockResolvedValue({ success: false, error: "CODE_EXPIRED" }),
		};
		const services: ServiceMap = new Map([["OWNER_BIND_VERIFY", verifySvc]]);
		const runtime = makeRuntime(services);
		const interaction = makePairInteraction("333", "carol", "000000");

		await handleElizaPairCommand(interaction as never, runtime as never);

		const replyCall = (interaction.reply as ReturnType<typeof vi.fn>).mock
			.calls[0][0] as { content: string };
		expect(replyCall.content).toMatch(/invalid or expired/i);
	});

	it("replies with error message when OWNER_BIND_VERIFY service is absent", async () => {
		const runtime = makeRuntime(); // no services registered
		const interaction = makePairInteraction("444", "dave", "123456");

		await handleElizaPairCommand(interaction as never, runtime as never);

		const replyCall = (interaction.reply as ReturnType<typeof vi.fn>).mock
			.calls[0][0] as { content: string };
		expect(replyCall.content).toMatch(/could not reach/i);
	});

	it("enforces per-user rate limit after 5 attempts within one minute", async () => {
		const verifySvc = {
			verifyOwnerBindFromConnector: vi
				.fn()
				.mockResolvedValue({ success: false }),
		};
		const services: ServiceMap = new Map([["OWNER_BIND_VERIFY", verifySvc]]);
		const runtime = makeRuntime(services);

		// Fire 5 attempts — all should reach the backend.
		for (let i = 0; i < 5; i++) {
			const interaction = makePairInteraction("555", "eve", "111111");
			await handleElizaPairCommand(interaction as never, runtime as never);
		}
		expect(verifySvc.verifyOwnerBindFromConnector).toHaveBeenCalledTimes(5);

		// 6th attempt must be blocked by the rate limiter.
		const blockedInteraction = makePairInteraction("555", "eve", "111111");
		await handleElizaPairCommand(blockedInteraction as never, runtime as never);

		const blockedReply = (blockedInteraction.reply as ReturnType<typeof vi.fn>)
			.mock.calls[0][0] as { content: string };
		expect(blockedReply.content).toMatch(/too many/i);

		// Backend should still be called only 5 times.
		expect(verifySvc.verifyOwnerBindFromConnector).toHaveBeenCalledTimes(5);
	});
});

// --------------------------------------------------------------------------
// DM-link sender tests
// --------------------------------------------------------------------------

describe("DiscordOwnerPairingService.sendOwnerLoginDmLink", () => {
	it("sends the link as a DM with expected message body", async () => {
		const sendMock = vi.fn().mockResolvedValue(undefined);
		const dmChannel = { send: sendMock };
		const userFetchMock = vi.fn().mockResolvedValue({
			createDM: vi.fn().mockResolvedValue(dmChannel),
		});
		const discordClientMock = { users: { fetch: userFetchMock } };
		const discordSvcMock = { client: discordClientMock };

		const services: ServiceMap = new Map([["discord", discordSvcMock]]);
		const runtime = makeRuntime(services);

		// We construct the service directly to avoid starting the Discord client.
		// start() calls registerPairCommand which needs addCommand from
		// slash-commands — that import triggers discord.js. Instead, instantiate
		// via the constructor and set runtime manually.
		const instance = new (
			DiscordOwnerPairingServiceImpl as unknown as new (
				runtime: unknown,
			) => DiscordOwnerPairingServiceImpl
		)(runtime as never);

		const link = "https://eliza.local/auth/login?token=abc123";
		await instance.sendOwnerLoginDmLink({
			externalId: "777888999",
			link,
		});

		expect(userFetchMock).toHaveBeenCalledWith("777888999");
		expect(sendMock).toHaveBeenCalledOnce();
		const messageBody = (sendMock as ReturnType<typeof vi.fn>).mock
			.calls[0][0] as string;
		expect(messageBody).toContain(link);
		expect(messageBody).toContain("Click to log in to Eliza");
		expect(messageBody).toContain("expires in 5 minutes");
	});

	it("throws when Discord client is not available", async () => {
		const runtime = makeRuntime(); // no discord service

		const instance = new (
			DiscordOwnerPairingServiceImpl as unknown as new (
				runtime: unknown,
			) => DiscordOwnerPairingServiceImpl
		)(runtime as never);

		await expect(
			instance.sendOwnerLoginDmLink({
				externalId: "999",
				link: "https://example.com",
			}),
		).rejects.toThrow(/not available/i);
	});
});
