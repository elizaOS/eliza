/**
 * Pins the core fallback store to the same participant-room entity isolation
 * used by plugin-sql and plugin-inmemorydb, including the autonomy provider's
 * real global bounded query shape.
 */
import { describe, expect, it } from "vitest";
import { adminChatProvider } from "../features/autonomy/providers";
import {
	AUTONOMY_SERVICE_TYPE,
	type AutonomyService,
} from "../features/autonomy/service";
import { createMockRuntime } from "../testing/mock-runtime";
import type { IAgentRuntime, Memory, UUID } from "../types";
import { stringToUuid } from "../utils";
import { InMemoryDatabaseAdapter } from "./inMemoryAdapter";

const AGENT = "10000000-0000-0000-0000-000000000001" as UUID;
const ADMIN_USER_ID = "core-fallback-admin";
const ADMIN = stringToUuid(ADMIN_USER_ID);
const OTHER = "10000000-0000-0000-0000-000000000003" as UUID;
const AUTONOMY_ENTITY = "10000000-0000-0000-0000-000000000004" as UUID;
const ADMIN_ROOM = "20000000-0000-0000-0000-000000000001" as UUID;
const UNRELATED_ROOM = "20000000-0000-0000-0000-000000000002" as UUID;
const AUTONOMOUS_ROOM = "20000000-0000-0000-0000-000000000003" as UUID;

function memory(
	id: string,
	entityId: UUID,
	roomId: UUID,
	text: string,
	createdAt: number,
	agentId = AGENT,
): Memory {
	return {
		id: id as UUID,
		agentId,
		entityId,
		roomId,
		createdAt,
		content: { text },
	};
}

describe("core in-memory entity isolation parity", () => {
	it("allows same-room authors, denies unrelated rooms, and preserves agent-owned documents", async () => {
		const adapter = new InMemoryDatabaseAdapter(AGENT);
		await adapter.createRoomParticipants([ADMIN], ADMIN_ROOM);
		await adapter.createMemories([
			{
				memory: memory(
					"30000000-0000-0000-0000-000000000001",
					OTHER,
					ADMIN_ROOM,
					"same-room reply",
					1,
				),
				tableName: "memories",
			},
			{
				memory: memory(
					"30000000-0000-0000-0000-000000000002",
					ADMIN,
					UNRELATED_ROOM,
					"unrelated authored row",
					2,
				),
				tableName: "memories",
			},
			{
				memory: memory(
					"30000000-0000-0000-0000-000000000003",
					OTHER,
					UNRELATED_ROOM,
					"agent-owned document",
					3,
					ADMIN,
				),
				tableName: "documents",
			},
		]);

		await expect(
			adapter.getMemories({
				entityId: ADMIN,
				agentId: AGENT,
				tableName: "memories",
			}),
		).resolves.toMatchObject([{ content: { text: "same-room reply" } }]);
		await expect(
			adapter.getMemories({
				entityId: ADMIN,
				agentId: ADMIN,
				tableName: "documents",
			}),
		).resolves.toMatchObject([{ content: { text: "agent-owned document" } }]);
	});

	it("keeps unrelated agent rows out of the real admin history provider", async () => {
		const adapter = new InMemoryDatabaseAdapter(AGENT);
		await adapter.createRoomParticipants([ADMIN, AGENT], ADMIN_ROOM);
		await adapter.createRoomParticipants(
			[AGENT, AUTONOMY_ENTITY],
			AUTONOMOUS_ROOM,
		);
		await adapter.createRoomParticipants([OTHER, AGENT], UNRELATED_ROOM);
		await adapter.createMemories([
			{
				memory: memory(
					"40000000-0000-0000-0000-000000000001",
					ADMIN,
					ADMIN_ROOM,
					"trusted admin turn",
					1,
				),
				tableName: "memories",
			},
			{
				memory: memory(
					"40000000-0000-0000-0000-000000000002",
					AGENT,
					ADMIN_ROOM,
					"trusted agent reply",
					2,
				),
				tableName: "memories",
			},
			{
				memory: memory(
					"40000000-0000-0000-0000-000000000003",
					AGENT,
					UNRELATED_ROOM,
					"UNRELATED LEAK",
					3,
				),
				tableName: "memories",
			},
			{
				memory: memory(
					"40000000-0000-0000-0000-000000000004",
					AGENT,
					AUTONOMOUS_ROOM,
					"internal autonomy turn",
					4,
				),
				tableName: "memories",
			},
		]);

		const autonomyService = {
			getAutonomousRoomId: () => AUTONOMOUS_ROOM,
		} as Pick<AutonomyService, "getAutonomousRoomId">;
		const runtime = createMockRuntime({
			agentId: AGENT,
			getSetting: (key: string) =>
				key === "ADMIN_USER_ID" ? ADMIN_USER_ID : undefined,
			getService: ((serviceType: string) =>
				serviceType === AUTONOMY_SERVICE_TYPE
					? autonomyService
					: null) as IAgentRuntime["getService"],
			getMemories: (params) => adapter.getMemories(params),
		});

		const result = await adminChatProvider.get(runtime, {
			agentId: AGENT,
			entityId: AUTONOMY_ENTITY,
			roomId: AUTONOMOUS_ROOM,
			content: { text: "tick" },
		});

		expect(result.text).toContain("Admin: trusted admin turn");
		expect(result.text).toContain("Agent: trusted agent reply");
		expect(result.text).not.toContain("UNRELATED LEAK");
		expect(result.text).not.toContain("internal autonomy turn");
	});
});
