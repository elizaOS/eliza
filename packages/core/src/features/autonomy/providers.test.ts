/**
 * Deterministic unit coverage for the autonomy context providers. The tests
 * drive each provider's real `get` implementation with typed runtime and
 * service stand-ins, covering room/service gates, history rendering, status
 * states, interval bounds, and explicit unavailable results without a model or
 * database.
 */
import { describe, expect, test, vi } from "vitest";
import { createMockRuntime } from "../../testing/mock-runtime.ts";
import type { IAgentRuntime, Memory, UUID } from "../../types/index.ts";
import { stringToUuid } from "../../utils.ts";
import { adminChatProvider, autonomyStatusProvider } from "./providers.ts";
import { AUTONOMY_SERVICE_TYPE, type AutonomyService } from "./service.ts";

const AGENT_ID = "10000000-0000-0000-0000-000000000000" as UUID;
const ROOM_ID = "20000000-0000-0000-0000-000000000000" as UUID;
const OTHER_ROOM_ID = "30000000-0000-0000-0000-000000000000" as UUID;
const ADMIN_USER_ID = "admin-user";
const ADMIN_ID = stringToUuid(ADMIN_USER_ID);

function message(roomId = ROOM_ID): Memory {
	return {
		agentId: AGENT_ID,
		entityId: ADMIN_ID,
		roomId,
		content: { text: "status" },
	};
}

function autonomyService(
	overrides: {
		autonomousRoomId?: UUID | null;
		running?: boolean;
		interval?: number;
	} = {},
): Pick<
	AutonomyService,
	"getAutonomousRoomId" | "getLoopInterval" | "isLoopRunning"
> {
	return {
		getAutonomousRoomId: () =>
			overrides.autonomousRoomId === undefined
				? ROOM_ID
				: overrides.autonomousRoomId,
		getLoopInterval: () => overrides.interval ?? 30_000,
		isLoopRunning: () => overrides.running ?? false,
	};
}

function runtimeWithService(
	service: ReturnType<typeof autonomyService> | null,
	overrides: Partial<IAgentRuntime> = {},
): IAgentRuntime {
	return createMockRuntime({
		agentId: AGENT_ID,
		getService: ((serviceType: string) =>
			serviceType === AUTONOMY_SERVICE_TYPE
				? service
				: null) as IAgentRuntime["getService"],
		...overrides,
	});
}

function historyMemory(
	entityId: UUID,
	text: string | undefined,
	createdAt?: number,
): Memory {
	return {
		agentId: AGENT_ID,
		entityId,
		roomId: ROOM_ID,
		createdAt,
		content: text === undefined ? {} : { text },
	};
}

describe("adminChatProvider", () => {
	test("returns an unavailable reason when the autonomy service is absent", async () => {
		const result = await adminChatProvider.get(
			createMockRuntime({ getService: () => null }),
			message(),
		);

		expect(result).toEqual({
			text: "",
			data: { available: false, reason: "autonomy_service_unavailable" },
		});
	});

	test.each([
		[null, ROOM_ID],
		[ROOM_ID, OTHER_ROOM_ID],
	] as const)(
		"stays out of non-autonomous rooms (autonomous room %s, message room %s)",
		async (autonomousRoomId, messageRoomId) => {
			const result = await adminChatProvider.get(
				runtimeWithService(autonomyService({ autonomousRoomId })),
				message(messageRoomId),
			);

			expect(result).toEqual({
				text: "",
				data: { available: false, reason: "not_autonomous_room" },
			});
		},
	);

	test("explains when no admin user is configured", async () => {
		const getMemories = vi.fn();
		const runtime = runtimeWithService(autonomyService(), {
			getSetting: () => undefined,
			getMemories,
		});

		const result = await adminChatProvider.get(runtime, message());

		expect(result.text).toContain("No admin user configured");
		expect(result.data).toEqual({
			adminConfigured: false,
			messageCount: 0,
		});
		expect(result.values).toEqual({
			adminConfigured: false,
			adminHistoryCount: 0,
		});
		expect(getMemories).not.toHaveBeenCalled();
	});

	test.each([null, []] as const)(
		"reports configured admin history with no messages for %s",
		async (memories) => {
			const getMemories = vi.fn(async () => memories as Memory[] | null);
			const runtime = runtimeWithService(autonomyService(), {
				getSetting: () => ADMIN_USER_ID,
				getMemories,
			});

			const result = await adminChatProvider.get(runtime, message());

			expect(result.text).toContain("No recent messages found");
			expect(result.data).toEqual({
				adminConfigured: true,
				messageCount: 0,
				adminUserId: ADMIN_USER_ID,
			});
			expect(getMemories).toHaveBeenCalledWith({
				entityId: ADMIN_ID,
				limit: 15,
				unique: false,
				tableName: "memories",
			});
		},
	);

	test("sorts and renders history while bounding the recent-admin window", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-23T12:00:00.000Z"));
		const otherId = "40000000-0000-0000-0000-000000000000" as UUID;
		const memories = [
			historyMemory(ADMIN_ID, "fourth admin", Date.now() - 1_000),
			historyMemory(AGENT_ID, "agent reply", Date.now() - 5_000),
			historyMemory(ADMIN_ID, "second admin", Date.now() - 4_000),
			historyMemory(otherId, undefined, Date.now() - 3_000),
			historyMemory(ADMIN_ID, "third \ud800 admin", Date.now() - 2_000),
			historyMemory(ADMIN_ID, "first admin", Date.now() - 6_000),
		];
		const runtime = runtimeWithService(autonomyService(), {
			getSetting: () => ADMIN_USER_ID,
			getMemories: async () => memories,
		});

		const result = await adminChatProvider.get(runtime, message());

		expect(result.text).toContain("Admin: first admin");
		expect(result.text).toContain("Agent: agent reply");
		expect(result.text).toContain("Other: [No text content]");
		expect(result.text).toContain("Admin: third � admin");
		expect(result.text).toContain('Last admin message: "fourth admin"');
		expect(result.text?.indexOf("first admin")).toBeLessThan(
			result.text?.indexOf("fourth admin") ?? -1,
		);
		expect(result.data).toMatchObject({
			adminConfigured: true,
			messageCount: 6,
			recentMessageCount: 3,
			lastAdminMessage: "fourth admin",
			conversationActive: true,
			historyWindowCount: 6,
		});
		expect(result.values).toEqual({
			adminConfigured: true,
			adminHistoryCount: 6,
			adminHistoryWindowCount: 6,
		});
		vi.useRealTimers();
	});

	test("marks old history inactive and renders an empty last admin message as N/A", async () => {
		const runtime = runtimeWithService(autonomyService(), {
			getSetting: () => ADMIN_USER_ID,
			getMemories: async () => [historyMemory(ADMIN_ID, "", 1)],
		});

		const result = await adminChatProvider.get(runtime, message());

		expect(result.text).toContain('Last admin message: "N/A"');
		expect(result.data).toMatchObject({
			lastAdminMessage: "",
			conversationActive: false,
		});
	});

	test("reports history lookup failures as unavailable", async () => {
		const failure = new Error("history store offline");
		const reportError = vi.fn();
		const runtime = runtimeWithService(autonomyService(), {
			getSetting: () => ADMIN_USER_ID,
			getMemories: vi.fn().mockRejectedValue(failure),
			reportError,
		});

		const result = await adminChatProvider.get(runtime, message());

		expect(result).toEqual({
			text: "Admin conversation history is unavailable.",
			data: {
				available: false,
				reason: "admin_history_unavailable",
				error: "history store offline",
			},
			values: { adminHistoryAvailable: false },
		});
		expect(reportError).toHaveBeenCalledWith(
			"AdminChatHistoryProvider.get",
			failure,
			{ roomId: ROOM_ID },
		);
	});
});

describe("autonomyStatusProvider", () => {
	test("returns an unavailable reason when the autonomy service is absent", async () => {
		const result = await autonomyStatusProvider.get(
			createMockRuntime({ getService: () => null }),
			message(OTHER_ROOM_ID),
		);

		expect(result).toEqual({
			text: "",
			data: { available: false, reason: "autonomy_service_unavailable" },
		});
	});

	test("omits status inside the autonomous room", async () => {
		const result = await autonomyStatusProvider.get(
			runtimeWithService(autonomyService()),
			message(),
		);

		expect(result).toEqual({
			text: "",
			data: { available: false, reason: "autonomous_room" },
		});
	});

	test("reports a running loop and caps its displayed interval at one day", async () => {
		const runtime = runtimeWithService(
			autonomyService({
				autonomousRoomId: ROOM_ID,
				running: true,
				interval: 2 * 24 * 60 * 60 * 1_000,
			}),
			{ enableAutonomy: false },
		);

		const result = await autonomyStatusProvider.get(
			runtime,
			message(OTHER_ROOM_ID),
		);

		expect(result.text).toContain("🤖 running autonomously");
		expect(result.text).toContain("Thinking interval: 1440 minutes");
		expect(result.data).toMatchObject({
			autonomyEnabled: false,
			serviceRunning: true,
			interval: 86_400_000,
			intervalSeconds: 86_400,
			status: "running",
		});
		expect(result.values).toEqual({
			autonomyEnabled: false,
			autonomyRunning: true,
			autonomyIntervalSeconds: 86_400,
		});
	});

	test.each([
		[true, "⏸️ autonomy enabled but not running", "enabled"],
		[false, "🔕 autonomy disabled", "disabled"],
	] as const)(
		"reports a stopped loop when enableAutonomy is %s",
		async (enableAutonomy, expectedText, expectedStatus) => {
			const runtime = runtimeWithService(
				autonomyService({
					autonomousRoomId: ROOM_ID,
					running: false,
					interval: 59_500,
				}),
				{ enableAutonomy },
			);

			const result = await autonomyStatusProvider.get(
				runtime,
				message(OTHER_ROOM_ID),
			);

			expect(result.text).toContain(expectedText);
			expect(result.text).toContain("Thinking interval: 1 minutes");
			expect(result.data).toMatchObject({
				interval: 59_500,
				intervalSeconds: 60,
				status: expectedStatus,
			});
		},
	);

	test("uses seconds below the minute threshold", async () => {
		const runtime = runtimeWithService(
			autonomyService({ autonomousRoomId: null, interval: 29_500 }),
			{ enableAutonomy: true },
		);

		const result = await autonomyStatusProvider.get(runtime, message());

		expect(result.text).toContain("Thinking interval: 30 seconds");
		expect(result.data).toMatchObject({ intervalSeconds: 30 });
	});

	test("reports service failures as unavailable", async () => {
		const failure = new Error("loop state unavailable");
		const reportError = vi.fn();
		const runtime = runtimeWithService(
			{
				...autonomyService({ autonomousRoomId: null }),
				isLoopRunning: () => {
					throw failure;
				},
			},
			{ reportError },
		);

		const result = await autonomyStatusProvider.get(runtime, message());

		expect(result).toEqual({
			text: "Autonomy status is unavailable.",
			data: {
				available: false,
				reason: "autonomy_status_unavailable",
				error: "loop state unavailable",
			},
			values: { autonomyStatusAvailable: false },
		});
		expect(reportError).toHaveBeenCalledWith(
			"AutonomyStatusProvider.get",
			failure,
			{ roomId: ROOM_ID },
		);
	});
});
