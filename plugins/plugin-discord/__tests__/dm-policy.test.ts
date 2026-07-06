/**
 * DM pairing-gate tests for MessageManager.checkDmAccess (#14710 residual):
 * the resolved bot owner / connector-admin whitelist members are the pairing
 * APPROVERS and must never be locked behind their own gate, while strangers
 * stay fail-closed when the PairingService is missing. Drives the real
 * checkDmAccess + checkPairingAllowed path over a deterministic fake runtime
 * (no vi.mock of core).
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { MessageManager } from "../messages";
import type { IDiscordService } from "../types";

const OWNER_SNOWFLAKE = "600000000000000002";
const STRANGER_SNOWFLAKE = "600000000000000009";

function makeManager(settings: Record<string, string> = {}): {
	manager: MessageManager;
	reportError: ReturnType<typeof vi.fn>;
} {
	const reportError = vi.fn();
	const runtime = {
		agentId: "11111111-1111-1111-1111-111111111111",
		character: { name: "TestAgent" },
		getSetting: (key: string) => settings[key],
		getService: () => null,
		reportError,
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	} as unknown as IAgentRuntime;
	const service = {
		client: { user: { id: "888000000000000000" } },
		accountId: "default",
		getChannelType: async () => "DM",
		discordSettings: {
			autoReply: true,
			dmPolicy: "pairing",
			shouldIgnoreBotMessages: true,
			shouldIgnoreDirectMessages: false,
			replyToMode: "first",
		},
	} as unknown as IDiscordService;
	return { manager: new MessageManager(service, runtime), reportError };
}

type DmAccessProbe = {
	checkDmAccess(message: {
		author: Record<string, unknown>;
	}): Promise<{ allowed: boolean }>;
};

function dmFrom(userId: string): { author: Record<string, unknown> } {
	return {
		author: {
			id: userId,
			username: "someone",
			displayName: "Someone",
			discriminator: "0",
		},
	};
}

describe("MessageManager.checkDmAccess — pairing policy (#14710)", () => {
	it("denies a stranger when the PairingService is missing (fail closed) and reports it", async () => {
		const { manager, reportError } = makeManager();
		const result = await (manager as unknown as DmAccessProbe).checkDmAccess(
			dmFrom(STRANGER_SNOWFLAKE),
		);
		expect(result.allowed).toBe(false);
		expect(reportError).toHaveBeenCalledTimes(1);
	});

	it("never locks the resolved owner / connector admins behind their own pairing gate", async () => {
		const { manager, reportError } = makeManager({
			ELIZA_ROLES_CONNECTOR_ADMINS_JSON: JSON.stringify({
				discord: [OWNER_SNOWFLAKE],
			}),
		});
		const result = await (manager as unknown as DmAccessProbe).checkDmAccess(
			dmFrom(OWNER_SNOWFLAKE),
		);
		expect(result.allowed).toBe(true);
		expect(reportError).not.toHaveBeenCalled();
	});
});
