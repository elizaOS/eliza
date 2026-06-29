import { beforeEach, describe, expect, it, vi } from "vitest";

// The `/app` role gate consults the agent role model. Mock it so each test
// controls the resolved trust level without a world/role graph.
const { hasRoleAccess } = vi.hoisted(() => ({ hasRoleAccess: vi.fn() }));
vi.mock("@elizaos/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@elizaos/core")>();
	return { ...actual, hasRoleAccess };
});

import type { IAgentRuntime } from "@elizaos/core";
import {
	getRegisteredCommands,
	handleSlashCommand,
	resolveDiscordEmbedUrl,
} from "../slash-commands";

const HTTPS_URL = "https://app.elizacloud.ai/embed";

function makeRuntime(settings: Record<string, string> = {}): IAgentRuntime {
	return {
		agentId: "agent-1",
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		getSetting: (key: string) => settings[key],
	} as unknown as IAgentRuntime;
}

function makeInteraction() {
	const reply = vi.fn(async () => undefined);
	return {
		interaction: {
			commandName: "app",
			user: { id: "555" },
			guild: null,
			deferred: false,
			replied: false,
			reply,
		} as never,
		reply,
	};
}

const context = { entityId: "entity-1", roomId: "room-1" };

beforeEach(() => {
	hasRoleAccess.mockReset();
});

describe("/app command registration (#9947)", () => {
	it("is registered, ephemeral, and ADMIN-gated", () => {
		const app = getRegisteredCommands().get("app");
		expect(app).toBeDefined();
		expect(app?.requiredRole).toBe("ADMIN");
		expect(app?.ephemeral).toBe(true);
	});
});

describe("resolveDiscordEmbedUrl", () => {
	it("prefers an explicit HTTPS DISCORD_ACTIVITY_URL", () => {
		expect(
			resolveDiscordEmbedUrl(makeRuntime({ DISCORD_ACTIVITY_URL: HTTPS_URL })),
		).toBe(HTTPS_URL);
	});

	it("derives /embed from the public app URL", () => {
		expect(
			resolveDiscordEmbedUrl(
				makeRuntime({ ELIZA_PUBLIC_URL: "https://app.elizacloud.ai" }),
			),
		).toBe(HTTPS_URL);
	});

	it("returns null when no HTTPS url is configured", () => {
		expect(resolveDiscordEmbedUrl(makeRuntime())).toBeNull();
	});
});

describe("/app role gate via handleSlashCommand", () => {
	it("refuses a non-admin sender (no launch link)", async () => {
		hasRoleAccess.mockResolvedValue(false);
		const { interaction, reply } = makeInteraction();
		await handleSlashCommand(
			interaction,
			makeRuntime({ DISCORD_ACTIVITY_URL: HTTPS_URL }),
			context,
		);
		expect(hasRoleAccess).toHaveBeenCalled();
		const content = (reply.mock.calls[0]?.[0] as { content: string }).content;
		expect(content).toContain("ADMIN");
		expect(content).not.toContain(HTTPS_URL);
	});

	it("returns the launch link for an admin sender", async () => {
		hasRoleAccess.mockResolvedValue(true);
		const { interaction, reply } = makeInteraction();
		await handleSlashCommand(
			interaction,
			makeRuntime({ DISCORD_ACTIVITY_URL: HTTPS_URL }),
			context,
		);
		const content = (reply.mock.calls[0]?.[0] as { content: string }).content;
		expect(content).toContain(HTTPS_URL);
	});
});
