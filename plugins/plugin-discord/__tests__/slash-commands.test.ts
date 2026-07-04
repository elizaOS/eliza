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
	getRegisteredCommands,
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
}

function makeInteraction(): MockInteraction {
	return {
		id: "interaction-1",
		channelId: "987654321098765432",
		user: { id: "123456789012345678", username: "tester" },
		reply: vi.fn(async () => undefined),
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
