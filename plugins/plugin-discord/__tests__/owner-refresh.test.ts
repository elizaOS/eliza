/**
 * Service-level Discord owner refresh tests. The harness calls the real
 * `DiscordService.prototype.refreshOwnerDiscordUserIds` with a fake ready
 * client so owner aliasing and connector-admin whitelist writes stay coupled.
 */
import { getConnectorAdminWhitelist, type IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { DiscordService } from "../service.ts";

const OWNER_ID = "123456789012345678";
const TEAM_MEMBER_ID = "234567890123456789";

function makeRuntime(): IAgentRuntime {
	const settings = new Map<string, string | null>();
	return {
		agentId: "agent-1",
		character: { name: "Eliza" },
		getSetting: (key: string) => settings.get(key),
		setSetting: (key: string, value: string | null) => {
			settings.set(key, value);
		},
		logger: {
			error: vi.fn(),
			warn: vi.fn(),
			info: vi.fn(),
			debug: vi.fn(),
		},
	} as unknown as IAgentRuntime;
}

describe("DiscordService.refreshOwnerDiscordUserIds", () => {
	it("keeps team members out of the owner alias set while whitelisting them as connector admins", async () => {
		const runtime = makeRuntime();
		const service = Object.assign(Object.create(DiscordService.prototype), {
			runtime,
		}) as DiscordService;
		const client = {
			application: {
				fetch: vi.fn().mockResolvedValue({
					team: {
						ownerId: OWNER_ID,
						members: [
							{ user: { id: OWNER_ID } },
							{ user: { id: TEAM_MEMBER_ID } },
						],
					},
				}),
			},
		};

		await service.refreshOwnerDiscordUserIds(client as never);

		const ownerAliases = (
			service as unknown as { ownerDiscordUserIds: Set<string> }
		).ownerDiscordUserIds;
		expect([...ownerAliases]).toEqual([OWNER_ID]);
		expect(getConnectorAdminWhitelist(runtime).discord).toEqual([
			OWNER_ID,
			TEAM_MEMBER_ID,
		]);
	});
});
