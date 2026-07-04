/**
 * Unit tests for the `/eliza-pair` command handler and
 * `DiscordOwnerPairingServiceImpl` — pairing-code relay and DM login links,
 * against a mocked runtime and backend.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetRateLimitStateForTesting,
	DiscordOwnerPairingServiceImpl,
	handleElizaPairCommand,
} from "../owner-pairing-service";

function makeRuntime(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
	return {
		agentId: "11111111-1111-1111-1111-111111111111",
		emitEvent: vi.fn(),
		getService: vi.fn(() => null),
		logger: {
			debug: vi.fn(),
			error: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
		},
		...overrides,
	} as unknown as IAgentRuntime;
}

function makeInteraction(code: string | null, userId = "123456789012345678") {
	return {
		user: {
			id: userId,
			username: "owner",
			discriminator: "0",
		},
		options: {
			getString: vi.fn(() => code),
		},
		reply: vi.fn(async () => undefined),
	};
}

describe("handleElizaPairCommand", () => {
	beforeEach(() => {
		_resetRateLimitStateForTesting();
	});

	it("rejects malformed pair codes without calling backend verification", async () => {
		const verify = vi.fn();
		const runtime = makeRuntime({
			getService: vi.fn((name: string) =>
				name === "OWNER_BIND_VERIFY"
					? { verifyOwnerBindFromConnector: verify }
					: null,
			) as IAgentRuntime["getService"],
		});
		const interaction = makeInteraction("12<script>");

		await handleElizaPairCommand(interaction as never, runtime);

		expect(verify).not.toHaveBeenCalled();
		expect(interaction.reply).toHaveBeenCalledWith({
			content:
				"The pairing code must be exactly 6 digits. Check the Eliza dashboard and try again.",
			ephemeral: true,
		});
	});

	it("fails closed when the backend verify service is unavailable", async () => {
		const runtime = makeRuntime();
		const interaction = makeInteraction("123456");

		await handleElizaPairCommand(interaction as never, runtime);

		expect(interaction.reply).toHaveBeenCalledWith({
			content:
				"Eliza could not reach the pairing service right now. Please try again in a moment.",
			ephemeral: true,
		});
		expect(runtime.emitEvent).toHaveBeenCalledWith(
			["AUTH_AUDIT"],
			expect.objectContaining({
				action: "auth.owner.pair.discord.service_unavailable",
				outcome: "failure",
			}),
		);
	});

	it("reports a verification error without exposing backend exception text", async () => {
		const runtime = makeRuntime({
			getService: vi.fn((name: string) =>
				name === "OWNER_BIND_VERIFY"
					? {
							verifyOwnerBindFromConnector: vi.fn(async () => {
								throw new Error("database password leaked");
							}),
						}
					: null,
			) as IAgentRuntime["getService"],
		});
		const interaction = makeInteraction("123456");

		await handleElizaPairCommand(interaction as never, runtime);

		expect(interaction.reply).toHaveBeenCalledWith({
			content:
				"Something went wrong while verifying the pairing code. Please try again.",
			ephemeral: true,
		});
		expect(JSON.stringify(interaction.reply.mock.calls)).not.toContain(
			"database password leaked",
		);
	});

	it("rate-limits repeated attempts by Discord user id", async () => {
		const runtime = makeRuntime({
			getService: vi.fn((name: string) =>
				name === "OWNER_BIND_VERIFY"
					? {
							verifyOwnerBindFromConnector: vi.fn(async () => ({
								success: false,
							})),
						}
					: null,
			) as IAgentRuntime["getService"],
		});

		for (let i = 0; i < 5; i += 1) {
			await handleElizaPairCommand(makeInteraction("123456") as never, runtime);
		}
		const limited = makeInteraction("123456");
		await handleElizaPairCommand(limited as never, runtime);

		expect(limited.reply).toHaveBeenCalledWith({
			content:
				"Too many pairing attempts. Please wait a moment before trying again.",
			ephemeral: true,
		});
	});
});

describe("DiscordOwnerPairingServiceImpl", () => {
	it("rejects malformed Discord external IDs before fetching a DM user", async () => {
		const fetch = vi.fn();
		const runtime = makeRuntime({
			getService: vi.fn((name: string) =>
				name === "discord" ? { client: { users: { fetch } } } : null,
			) as IAgentRuntime["getService"],
		});
		const service = new DiscordOwnerPairingServiceImpl(runtime);

		await expect(
			service.sendOwnerLoginDmLink({
				externalId: "not-a-snowflake",
				link: "https://login.example/once",
			}),
		).rejects.toThrow("Discord externalId must be a valid snowflake");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("surfaces Discord DM send failures without fetching login links", async () => {
		const send = vi.fn(async () => {
			throw new Error("Cannot send messages to this user");
		});
		const createDM = vi.fn(async () => ({ send }));
		const fetch = vi.fn(async () => ({ createDM }));
		const runtime = makeRuntime({
			getService: vi.fn((name: string) =>
				name === "discord" ? { client: { users: { fetch } } } : null,
			) as IAgentRuntime["getService"],
		});
		const service = new DiscordOwnerPairingServiceImpl(runtime);

		await expect(
			service.sendOwnerLoginDmLink({
				externalId: "123456789012345678",
				link: "https://login.example/once",
			}),
		).rejects.toThrow(
			"Failed to send DM login link to Discord user 123456789012345678: Cannot send messages to this user",
		);
		expect(fetch).toHaveBeenCalledWith("123456789012345678");
		expect(send).toHaveBeenCalledWith(
			expect.stringContaining("https://login.example/once"),
		);
	});
});
