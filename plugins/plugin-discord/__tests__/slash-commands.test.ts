/**
 * Unit tests for the `/app` embedded-app launch slash command (#9947).
 * Mocked runtime and interaction.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `/app` is role-gated through the agent role model (`hasRoleAccess`). Mock it
// so each test controls the member's resolved trust level without standing up
// a full world/role graph. `vi.hoisted` is required because `vi.mock` factories
// are hoisted above imports. (#9947)
const { hasRoleAccess } = vi.hoisted(() => ({
	hasRoleAccess: vi.fn(async () => true),
}));
vi.mock("@elizaos/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@elizaos/core")>();
	return { ...actual, hasRoleAccess };
});

import {
	addCommand,
	getRegisteredCommands,
	handleSlashCommand,
	registerSlashCommands,
	type SlashCommand,
} from "../slash-commands";

const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const HTTPS_EMBED_URL = "https://app.eliza.example/embed";
const HTTPS_DISCORD_EMBED_URL =
	"https://app.eliza.example/embed?platform=discord";

function makeRuntime(settings: Record<string, string> = {}): IAgentRuntime {
	return {
		agentId: AGENT_ID,
		getSetting: vi.fn((key: string) => settings[key]),
		character: { name: "TestAgent" },
		logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
		emitEvent: vi.fn(async () => undefined),
	} as unknown as IAgentRuntime;
}

interface MockInteraction {
	id: string;
	channelId: string;
	user: { id: string; username: string };
	reply: ReturnType<typeof vi.fn>;
	editReply: ReturnType<typeof vi.fn>;
	deferred: boolean;
	replied: boolean;
	commandName: string;
	guild: { ownerId: string } | null;
}

function makeInteraction(commandName = "app"): MockInteraction {
	return {
		id: "interaction-1",
		channelId: "987654321098765432",
		user: { id: "123456789012345678", username: "tester" },
		commandName,
		reply: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
		deferred: false,
		replied: false,
		guild: { ownerId: "guild-owner" },
	};
}

function appCommand(): SlashCommand {
	const cmd = getRegisteredCommands().get("app");
	if (!cmd) throw new Error('built-in "/app" command not registered');
	return cmd;
}

function lastReply(interaction: MockInteraction): {
	content: string;
	ephemeral: boolean;
} {
	const calls = interaction.reply.mock.calls;
	return calls[calls.length - 1][0] as {
		content: string;
		ephemeral: boolean;
	};
}

describe("/app embedded-app launch command (#9947)", () => {
	beforeEach(() => {
		hasRoleAccess.mockReset();
		hasRoleAccess.mockResolvedValue(true);
	});

	it("is registered through registerSlashCommands", async () => {
		const runtime = makeRuntime();
		await registerSlashCommands(runtime);
		const emit = runtime.emitEvent as ReturnType<typeof vi.fn>;
		expect(emit).toHaveBeenCalledTimes(1);
		const payload = emit.mock.calls[0][1] as {
			commands: Array<{ name: string }>;
		};
		expect(payload.commands.some((c) => c.name === "app")).toBe(true);
	});

	it("returns the platform-tagged https /embed launch link for an elevated member", async () => {
		hasRoleAccess.mockResolvedValue(true);
		const interaction = makeInteraction();
		await appCommand().execute(
			interaction as never,
			makeRuntime({ ELIZA_EMBED_URL: HTTPS_EMBED_URL }),
		);

		const reply = lastReply(interaction);
		expect(reply.ephemeral).toBe(true);
		expect(reply.content).toContain(HTTPS_DISCORD_EMBED_URL);
		// The gate was evaluated against the ADMIN role.
		expect(hasRoleAccess).toHaveBeenCalled();
		expect(hasRoleAccess.mock.calls[0][2]).toBe("ADMIN");
	});

	it("derives <web base>/embed from ELIZA_APP_URL", async () => {
		hasRoleAccess.mockResolvedValue(true);
		const interaction = makeInteraction();
		await appCommand().execute(
			interaction as never,
			makeRuntime({ ELIZA_APP_URL: "https://app.eliza.example/" }),
		);

		expect(lastReply(interaction).content).toContain(HTTPS_DISCORD_EMBED_URL);
	});

	it("returns an ephemeral denial for a non-elevated member", async () => {
		hasRoleAccess.mockResolvedValue(false);
		const interaction = makeInteraction();
		await appCommand().execute(
			interaction as never,
			makeRuntime({ ELIZA_EMBED_URL: HTTPS_EMBED_URL }),
		);

		const reply = lastReply(interaction);
		expect(reply.ephemeral).toBe(true);
		expect(reply.content).not.toContain(HTTPS_EMBED_URL);
		expect(reply.content).toMatch(/ADMIN/);
	});

	it("tells an elevated member when no embed url is configured", async () => {
		hasRoleAccess.mockResolvedValue(true);
		const interaction = makeInteraction();
		await appCommand().execute(interaction as never, makeRuntime());

		const reply = lastReply(interaction);
		expect(reply.ephemeral).toBe(true);
		expect(reply.content).not.toContain("https://");
		expect(reply.content).toMatch(/ELIZA_EMBED_URL/);
	});
});

describe("slash command dispatcher role gates (#14710)", () => {
	beforeEach(() => {
		hasRoleAccess.mockReset();
		hasRoleAccess.mockResolvedValue(true);
	});

	it("denies a role-gated command when dispatch context is missing", async () => {
		const execute = vi.fn(async () => undefined);
		addCommand({
			name: "gated_missing_context",
			description: "gated",
			requiredRole: "ADMIN",
			execute,
		});
		const interaction = makeInteraction("gated_missing_context");

		await handleSlashCommand(interaction as never, makeRuntime());

		expect(hasRoleAccess).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
		expect(lastReply(interaction).content).toContain("Unable to verify");
	});

	it("denies a role-gated command when role resolution throws", async () => {
		hasRoleAccess.mockRejectedValue(new Error("role backend down"));
		const execute = vi.fn(async () => undefined);
		addCommand({
			name: "gated_role_error",
			description: "gated",
			requiredRole: "ADMIN",
			execute,
		});
		const interaction = makeInteraction("gated_role_error");

		await handleSlashCommand(interaction as never, makeRuntime(), {
			entityId: "entity-1",
			roomId: "room-1",
		});

		expect(hasRoleAccess).toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
		expect(lastReply(interaction).content).toContain("ADMIN");
	});

	it("does not execute when a denial reply fails", async () => {
		hasRoleAccess.mockResolvedValue(false);
		const execute = vi.fn(async () => undefined);
		addCommand({
			name: "gated_reply_failure",
			description: "gated",
			requiredRole: "ADMIN",
			execute,
		});
		const interaction = makeInteraction("gated_reply_failure");
		interaction.reply.mockRejectedValueOnce(new Error("interaction expired"));

		await expect(
			handleSlashCommand(interaction as never, makeRuntime(), {
				entityId: "entity-1",
				roomId: "room-1",
			}),
		).rejects.toThrow("interaction expired");

		expect(execute).not.toHaveBeenCalled();
	});

	it("checks ownerOnly through the elizaOS OWNER role instead of Discord guild ownership", async () => {
		hasRoleAccess.mockResolvedValue(false);
		const execute = vi.fn(async () => undefined);
		addCommand({
			name: "owner_only",
			description: "owner",
			ownerOnly: true,
			execute,
		});
		const interaction = makeInteraction("owner_only");
		interaction.user.id = "guild-owner";

		await handleSlashCommand(interaction as never, makeRuntime(), {
			entityId: "entity-1",
			roomId: "room-1",
		});

		expect(hasRoleAccess.mock.calls[0][2]).toBe("OWNER");
		expect(execute).not.toHaveBeenCalled();
		expect(lastReply(interaction).content).toContain("OWNER");
	});
});

describe("builtin command surface (privileged plumbing hidden from pickers)", () => {
	it("does not register the removed placebo /model command", () => {
		// /model claimed "switching is noted" while changing nothing — the real
		// model surface is the app's Models & Providers screen.
		expect(getRegisteredCommands().has("model")).toBe(false);
	});

	it("marks privileged builtins with requiredPermissions and leaves user commands open", () => {
		const commands = getRegisteredCommands();
		for (const name of ["settings", "setup", "app", "transcribe"]) {
			expect(
				commands.get(name)?.requiredPermissions,
				`${name} must carry requiredPermissions`,
			).toBeTruthy();
		}
		// /clear was removed: it only explained that clearing isn't wired up,
		// which /help already covers — placebo commands don't earn picker space.
		expect(commands.get("clear")).toBeUndefined();
		for (const name of ["help", "status", "search"]) {
			expect(
				commands.get(name)?.requiredPermissions,
				`${name} must stay visible to everyone`,
			).toBeUndefined();
		}
	});

	it("transforms requiredPermissions into default_member_permissions on the wire", async () => {
		const { transformCommandToDiscordApi } = await import(
			"../discord-commands"
		);
		const setup = getRegisteredCommands().get("setup");
		const help = getRegisteredCommands().get("help");
		if (!setup || !help) throw new Error("builtins missing");
		const wireSetup = transformCommandToDiscordApi(
			setup as never,
		) as unknown as {
			default_member_permissions?: string;
		};
		const wireHelp = transformCommandToDiscordApi(help as never) as unknown as {
			default_member_permissions?: string;
		};
		// Administrator bit, stringified for the REST payload.
		expect(wireSetup.default_member_permissions).toBe("8");
		expect(wireHelp.default_member_permissions).toBeUndefined();
	});
});
