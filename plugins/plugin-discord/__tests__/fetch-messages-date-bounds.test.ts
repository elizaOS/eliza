/**
 * fetchConnectorMessages accepts ISO dates for before/after (the connector
 * contract documents both as dates or ids). Discord's API only takes
 * snowflakes, so a date is converted to the snowflake of that instant.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { DiscordService } from "../service.ts";

const DISCORD_EPOCH_MS = 1_420_070_400_000n;
const snowflakeAt = (iso: string) =>
	((BigInt(Date.parse(iso)) - DISCORD_EPOCH_MS) << 22n).toString();

function makeService(
	pages: Array<Array<{ id: string; createdTimestamp: number }>>,
) {
	const calls: Array<Record<string, unknown>> = [];
	const service = Object.create(DiscordService.prototype) as DiscordService &
		Record<string, unknown>;
	service.runtime = { agentId: "agent" } as unknown as IAgentRuntime;
	service.resolveAccountIdFromTarget = () => "default";
	service.resolveConnectorTextChannel = async () => ({
		messages: {
			fetch: async (options: Record<string, unknown>) => {
				calls.push(options);
				const page = pages.shift() ?? [];
				return new Map(page.map((m) => [m.id, m]));
			},
		},
	});
	service.buildMemoryFromMessage = async (message: {
		id: string;
		createdTimestamp: number;
	}) =>
		({
			id: message.id,
			createdAt: message.createdTimestamp,
		}) as unknown as Memory;
	return { service, calls };
}

const message = (iso: string) => ({
	id: snowflakeAt(iso),
	createdTimestamp: Date.parse(iso),
	content: "",
	attachments: new Map(),
});

describe("DiscordService.fetchConnectorMessages date bounds", () => {
	it("sends an ISO before date as the snowflake of that instant", async () => {
		const { service, calls } = makeService([[]]);
		await service.fetchConnectorMessages(
			{ runtime: service.runtime } as never,
			{
				target: { source: "discord", channelId: "c1" },
				before: "2026-10-24T00:00:00Z",
				limit: 10,
			} as never,
		);
		expect(calls[0]?.before).toBe(snowflakeAt("2026-10-24T00:00:00Z"));
	});

	it("keeps only messages after an ISO after date", async () => {
		const newer = message("2026-10-24T12:00:00Z");
		const older = message("2026-10-23T12:00:00Z");
		const { service } = makeService([[newer, older]]);
		const memories = await service.fetchConnectorMessages(
			{ runtime: service.runtime } as never,
			{
				target: { source: "discord", channelId: "c1" },
				after: "2026-10-24T00:00:00Z",
				limit: 10,
			} as never,
		);
		expect(memories.map((m) => m.id)).toEqual([newer.id]);
	});

	it("passes a message id through unchanged", async () => {
		const { service, calls } = makeService([[]]);
		await service.fetchConnectorMessages(
			{ runtime: service.runtime } as never,
			{
				target: { source: "discord", channelId: "c1" },
				before: "1300000000000000000",
				limit: 10,
			} as never,
		);
		expect(calls[0]?.before).toBe("1300000000000000000");
	});
});
