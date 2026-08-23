/**
 * Unit tests for the autonomy feature's two providers. Drives the real
 * `adminChatProvider.get` and `autonomyStatusProvider.get` implementations
 * against a mocked `IAgentRuntime` plus a stub `AutonomyService`, asserting the
 * observable provider contracts: availability gates, admin-history query shape,
 * rendering order and sender roles, the three-message admin recency window,
 * one-hour activity detection, interval rounding/clamping, and the J4
 * error-translation paths. Deterministic harness: no model, database, network,
 * or real runtime involvement.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, Memory, UUID } from "../../types";
import { stringToUuid } from "../../utils";
import { adminChatProvider, autonomyStatusProvider } from "./providers";
import type { AutonomyService } from "./service";
import { AUTONOMY_SERVICE_TYPE } from "./service";

const agentId = stringToUuid("providers-test-agent") as UUID;
const adminUserId = "admin-user";
const adminUUID = stringToUuid(adminUserId) as UUID;
const otherUUID = stringToUuid("other-entity") as UUID;
const autonomousRoomId = stringToUuid("providers-test-autonomous-room") as UUID;
const otherRoomId = stringToUuid("providers-test-other-room") as UUID;

let sequence = 0;

function memory(
	roomId: UUID,
	entityId: UUID,
	text: string,
	createdAt?: number,
): Memory {
	sequence += 1;
	return {
		id: stringToUuid(`providers-test-memory-${sequence}`) as UUID,
		entityId,
		roomId,
		...(createdAt === undefined ? {} : { createdAt }),
		content: { text },
	};
}

type ServiceStub = Pick<
	AutonomyService,
	"getAutonomousRoomId" | "isLoopRunning" | "getLoopInterval"
>;

function buildRuntime(parts: {
	service?: ServiceStub | null;
	settings?: Record<string, string>;
	memories?: () => Promise<Memory[] | null>;
	enableAutonomy?: boolean;
}) {
	const service =
		parts.service === undefined
			? ({
					getAutonomousRoomId: () => autonomousRoomId,
					isLoopRunning: () => false,
					getLoopInterval: () => 30_000,
				} satisfies ServiceStub)
			: parts.service;
	const runtime = {
		agentId,
		enableAutonomy: parts.enableAutonomy ?? false,
		getService: vi.fn((serviceType: string) =>
			serviceType === AUTONOMY_SERVICE_TYPE ? service : null,
		),
		getSetting: vi.fn((key: string) => parts.settings?.[key]),
		getMemories: vi.fn(parts.memories ?? (async () => [])),
		reportError: vi.fn(),
	} as unknown as IAgentRuntime & {
		getMemories: ReturnType<typeof vi.fn>;
		reportError: ReturnType<typeof vi.fn>;
	};
	return runtime;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("adminChatProvider", () => {
	it("returns autonomy_service_unavailable when the service is absent", async () => {
		const runtime = buildRuntime({ service: null });
		const result = await adminChatProvider.get(
			runtime,
			memory(otherRoomId, otherUUID, "hello"),
		);
		expect(result.text).toBe("");
		expect(result.data).toEqual({
			available: false,
			reason: "autonomy_service_unavailable",
		});
		expect(runtime.getMemories).not.toHaveBeenCalled();
	});

	it("returns not_autonomous_room when the service has no autonomous room", async () => {
		const runtime = buildRuntime({
			service: {
				getAutonomousRoomId: () => null,
				isLoopRunning: () => false,
				getLoopInterval: () => 30_000,
			},
		});
		const result = await adminChatProvider.get(
			runtime,
			memory(otherRoomId, otherUUID, "hello"),
		);
		expect(result.data).toEqual({
			available: false,
			reason: "not_autonomous_room",
		});
		expect(runtime.getSetting).not.toHaveBeenCalled();
		expect(runtime.getMemories).not.toHaveBeenCalled();
	});

	it("returns not_autonomous_room outside the autonomous room", async () => {
		const runtime = buildRuntime({
			settings: { ADMIN_USER_ID: adminUserId },
			memories: async () => [
				memory(autonomousRoomId, adminUUID, "should not load"),
			],
		});
		const result = await adminChatProvider.get(
			runtime,
			memory(otherRoomId, adminUUID, "hello"),
		);
		expect(result.data).toEqual({
			available: false,
			reason: "not_autonomous_room",
		});
		expect(runtime.getMemories).not.toHaveBeenCalled();
	});

	it("reports an unconfigured admin without touching memory", async () => {
		const runtime = buildRuntime({ settings: {} });
		const result = await adminChatProvider.get(
			runtime,
			memory(autonomousRoomId, otherUUID, "hello"),
		);
		expect(result.text).toContain("No admin user configured");
		expect(result.text).toContain("[ADMIN_CHAT_HISTORY]");
		expect(result.data).toMatchObject({
			adminConfigured: false,
			messageCount: 0,
		});
		expect(result.values).toEqual({
			adminConfigured: false,
			adminHistoryCount: 0,
		});
		expect(runtime.getMemories).not.toHaveBeenCalled();
	});

	it("reports an empty admin history as configured but silent", async () => {
		const runtime = buildRuntime({
			settings: { ADMIN_USER_ID: adminUserId },
			memories: async () => [],
		});
		const result = await adminChatProvider.get(
			runtime,
			memory(autonomousRoomId, otherUUID, "hello"),
		);
		expect(result.text).toContain("No recent messages found with admin user.");
		expect(result.data).toMatchObject({
			adminConfigured: true,
			messageCount: 0,
			adminUserId,
		});
		expect(result.values).toEqual({
			adminConfigured: true,
			adminHistoryCount: 0,
		});
	});

	it("tolerates a null memory lookup like an empty one", async () => {
		const runtime = buildRuntime({
			settings: { ADMIN_USER_ID: adminUserId },
			memories: async () => null,
		});
		const result = await adminChatProvider.get(
			runtime,
			memory(autonomousRoomId, otherUUID, "hello"),
		);
		expect(result.text).toContain("No recent messages found with admin user.");
		expect(result.values).toEqual({
			adminConfigured: true,
			adminHistoryCount: 0,
		});
	});

	it("queries admin memories with the canonical window parameters", async () => {
		const runtime = buildRuntime({
			settings: { ADMIN_USER_ID: adminUserId },
			memories: async () => [],
		});
		await adminChatProvider.get(
			runtime,
			memory(autonomousRoomId, otherUUID, "hello"),
		);
		expect(runtime.getMemories).toHaveBeenCalledTimes(1);
		expect(runtime.getMemories).toHaveBeenCalledWith({
			entityId: adminUUID,
			limit: 15,
			unique: false,
			tableName: "memories",
		});
	});

	it("renders history in ascending creation order with sender roles", async () => {
		const early = memory(autonomousRoomId, adminUUID, "first", 1_000);
		const middle = memory(autonomousRoomId, agentId, "second", 2_000);
		const late = memory(autonomousRoomId, otherUUID, "third", 3_000);
		const runtime = buildRuntime({
			settings: { ADMIN_USER_ID: adminUserId },
			memories: async () => [late, early, middle],
		});
		const result = await adminChatProvider.get(
			runtime,
			memory(autonomousRoomId, otherUUID, "hello"),
		);
		expect(result.text).toContain("(3 total messages)");
		const lines = [
			`${new Date(1_000).toLocaleTimeString()} Admin: first`,
			`${new Date(2_000).toLocaleTimeString()} Agent: second`,
			`${new Date(3_000).toLocaleTimeString()} Other: third`,
		];
		const history = lines.join("\n");
		expect(result.text).toContain(history);
		expect(result.data).toMatchObject({
			messageCount: 3,
			historyWindowCount: 3,
			recentMessageCount: 1,
			lastAdminMessage: "first",
		});
		expect(result.values).toEqual({
			adminConfigured: true,
			adminHistoryCount: 3,
			adminHistoryWindowCount: 3,
		});
	});

	it("substitutes a placeholder for blank message text", async () => {
		const runtime = buildRuntime({
			settings: { ADMIN_USER_ID: adminUserId },
			memories: async () => [memory(autonomousRoomId, adminUUID, "", 1_000)],
		});
		const result = await adminChatProvider.get(
			runtime,
			memory(autonomousRoomId, otherUUID, "hello"),
		);
		expect(result.text).toContain(`Admin: [No text content]`);
		expect(result.data).toMatchObject({
			lastAdminMessage: "",
		});
		expect(result.text).toContain('Last admin message: "N/A"');
	});

	it("sanitizes lone surrogates in history and the last admin message", async () => {
		const runtime = buildRuntime({
			settings: { ADMIN_USER_ID: adminUserId },
			memories: async () => [
				memory(autonomousRoomId, adminUUID, "bad\uD800line", 1_000),
			],
		});
		const result = await adminChatProvider.get(
			runtime,
			memory(autonomousRoomId, otherUUID, "hello"),
		);
		expect(result.text).toContain("Admin: bad\uFFFDline");
		expect(result.data).toMatchObject({ lastAdminMessage: "bad\uFFFDline" });
		expect(result.text).toContain('Last admin message: "bad\uFFFDline"');
	});

	it("limits the admin recency window to the newest three admin messages", async () => {
		const admin = (text: string, createdAt: number) =>
			memory(autonomousRoomId, adminUUID, text, createdAt);
		const runtime = buildRuntime({
			settings: { ADMIN_USER_ID: adminUserId },
			memories: async () => [
				admin("a1", 1_000),
				memory(autonomousRoomId, otherUUID, "noise", 1_500),
				admin("a2", 2_000),
				admin("a3", 3_000),
				admin("a4", 4_000),
				admin("a5", 5_000),
			],
		});
		const result = await adminChatProvider.get(
			runtime,
			memory(autonomousRoomId, otherUUID, "hello"),
		);
		expect(result.data).toMatchObject({
			recentMessageCount: 3,
			lastAdminMessage: "a5",
		});
		expect(result.text).toContain('Last admin message: "a5"');
		expect(result.text).not.toContain('"a1"');
		expect(result.text).not.toContain('"a2"');
	});

	it("reports zero admin context when no history is admin-authored", async () => {
		const runtime = buildRuntime({
			settings: { ADMIN_USER_ID: adminUserId },
			memories: async () => [
				memory(autonomousRoomId, otherUUID, "from other", 1_000),
				memory(autonomousRoomId, agentId, "from agent", 2_000),
			],
		});
		const result = await adminChatProvider.get(
			runtime,
			memory(autonomousRoomId, otherUUID, "hello"),
		);
		expect(result.text).toContain("No recent admin messages");
		expect(result.data).toMatchObject({
			recentMessageCount: 0,
			lastAdminMessage: "",
		});
	});

	it("marks the conversation active strictly inside the one-hour window", async () => {
		const now = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		const runtime = buildRuntime({
			settings: { ADMIN_USER_ID: adminUserId },
			memories: async () => [
				memory(autonomousRoomId, adminUUID, "recent", now - 3_599_999),
			],
		});
		const result = await adminChatProvider.get(
			runtime,
			memory(autonomousRoomId, otherUUID, "hello"),
		);
		expect(result.data).toMatchObject({ conversationActive: true });
	});

	it("keeps the conversation inactive at and beyond the one-hour boundary", async () => {
		const now = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		const runtime = buildRuntime({
			settings: { ADMIN_USER_ID: adminUserId },
			memories: async () => [
				memory(
					autonomousRoomId,
					adminUUID,
					"exactly one hour",
					now - 3_600_000,
				),
				memory(autonomousRoomId, otherUUID, "no timestamp"),
			],
		});
		const result = await adminChatProvider.get(
			runtime,
			memory(autonomousRoomId, otherUUID, "hello"),
		);
		expect(result.data).toMatchObject({ conversationActive: false });
	});

	it("translates failures into an explicitly unavailable history result", async () => {
		const failure = new Error("memory store down");
		const roomId = autonomousRoomId;
		const runtime = buildRuntime({
			settings: { ADMIN_USER_ID: adminUserId },
			memories: async () => {
				throw failure;
			},
		});
		const result = await adminChatProvider.get(
			runtime,
			memory(roomId, otherUUID, "hello"),
		);
		expect(result.text).toBe("Admin conversation history is unavailable.");
		expect(result.data).toMatchObject({
			available: false,
			reason: "admin_history_unavailable",
			error: "memory store down",
		});
		expect(result.values).toEqual({ adminHistoryAvailable: false });
		expect(runtime.reportError).toHaveBeenCalledWith(
			"AdminChatHistoryProvider.get",
			failure,
			{ roomId },
		);
	});

	it("stringifies non-Error failures", async () => {
		const runtime = buildRuntime({
			settings: { ADMIN_USER_ID: adminUserId },
			memories: async () => {
				throw "storage string failure";
			},
		});
		const result = await adminChatProvider.get(
			runtime,
			memory(autonomousRoomId, otherUUID, "hello"),
		);
		expect(result.data).toMatchObject({
			reason: "admin_history_unavailable",
			error: "storage string failure",
		});
		expect(runtime.reportError).toHaveBeenCalledWith(
			"AdminChatHistoryProvider.get",
			"storage string failure",
			{ roomId: autonomousRoomId },
		);
	});
});

describe("autonomyStatusProvider", () => {
	it("returns autonomy_service_unavailable when the service is absent", async () => {
		const runtime = buildRuntime({ service: null });
		const result = await autonomyStatusProvider.get(
			runtime,
			memory(otherRoomId, otherUUID, "status?"),
		);
		expect(result.text).toBe("");
		expect(result.data).toEqual({
			available: false,
			reason: "autonomy_service_unavailable",
		});
	});

	it("suppresses status inside the autonomous room", async () => {
		const runtime = buildRuntime({
			enableAutonomy: true,
			service: {
				getAutonomousRoomId: () => autonomousRoomId,
				isLoopRunning: () => true,
				getLoopInterval: () => 30_000,
			},
		});
		const result = await autonomyStatusProvider.get(
			runtime,
			memory(autonomousRoomId, otherUUID, "status?"),
		);
		expect(result.text).toBe("");
		expect(result.data).toEqual({
			available: false,
			reason: "autonomous_room",
		});
	});

	it("shows status when the service has no autonomous room", async () => {
		const runtime = buildRuntime({
			service: {
				getAutonomousRoomId: () => null,
				isLoopRunning: () => false,
				getLoopInterval: () => 30_000,
			},
		});
		const result = await autonomyStatusProvider.get(
			runtime,
			memory(autonomousRoomId, otherUUID, "status?"),
		);
		expect(result.text).toContain("[AUTONOMY_STATUS]");
		expect(result.text).toContain("🔕 autonomy disabled");
		expect(result.text).toContain("Thinking interval: 30 seconds");
		expect(result.data).toMatchObject({ status: "disabled" });
	});

	it("reports a running loop with the robot icon", async () => {
		const runtime = buildRuntime({
			enableAutonomy: true,
			service: {
				getAutonomousRoomId: () => autonomousRoomId,
				isLoopRunning: () => true,
				getLoopInterval: () => 45_000,
			},
		});
		const result = await autonomyStatusProvider.get(
			runtime,
			memory(otherRoomId, otherUUID, "status?"),
		);
		expect(result.text).toContain("🤖 running autonomously");
		expect(result.text).toContain("Thinking interval: 45 seconds");
		expect(result.data).toMatchObject({
			status: "running",
			serviceRunning: true,
			autonomyEnabled: true,
			interval: 45_000,
			intervalSeconds: 45,
		});
		expect(result.values).toEqual({
			autonomyEnabled: true,
			autonomyRunning: true,
			autonomyIntervalSeconds: 45,
		});
	});

	it("reports enabled-but-stopped autonomy with the pause icon", async () => {
		const runtime = buildRuntime({
			enableAutonomy: true,
			service: {
				getAutonomousRoomId: () => autonomousRoomId,
				isLoopRunning: () => false,
				getLoopInterval: () => 120_000,
			},
		});
		const result = await autonomyStatusProvider.get(
			runtime,
			memory(otherRoomId, otherUUID, "status?"),
		);
		expect(result.text).toContain("⏸️ autonomy enabled but not running");
		expect(result.text).toContain("Thinking interval: 2 minutes");
		expect(result.data).toMatchObject({ status: "enabled" });
	});

	it("keeps running status precedence over a disabled flag", async () => {
		const runtime = buildRuntime({
			enableAutonomy: false,
			service: {
				getAutonomousRoomId: () => autonomousRoomId,
				isLoopRunning: () => true,
				getLoopInterval: () => 30_000,
			},
		});
		const result = await autonomyStatusProvider.get(
			runtime,
			memory(otherRoomId, otherUUID, "status?"),
		);
		expect(result.text).toContain("🤖 running autonomously");
		expect(result.data).toMatchObject({
			status: "running",
			serviceRunning: true,
			autonomyEnabled: false,
		});
		expect(result.values).toEqual({
			autonomyEnabled: false,
			autonomyRunning: true,
			autonomyIntervalSeconds: 30,
		});
	});

	it.each([
		[30_000, "30 seconds"],
		[59_499, "59 seconds"],
		[59_500, "1 minutes"],
		[60_000, "1 minutes"],
		[90_000, "2 minutes"],
	] as const)(
		"formats a %s ms interval as %s",
		async (intervalMs, expectedUnit) => {
			const runtime = buildRuntime({
				service: {
					getAutonomousRoomId: () => autonomousRoomId,
					isLoopRunning: () => false,
					getLoopInterval: () => intervalMs,
				},
			});
			const result = await autonomyStatusProvider.get(
				runtime,
				memory(otherRoomId, otherUUID, "status?"),
			);
			expect(result.text).toContain(`Thinking interval: ${expectedUnit}`);
			expect(result.data).toMatchObject({
				interval: intervalMs,
				intervalSeconds: Math.round(intervalMs / 1000),
			});
		},
	);

	it("clamps intervals beyond twenty-four hours", async () => {
		const runtime = buildRuntime({
			service: {
				getAutonomousRoomId: () => autonomousRoomId,
				isLoopRunning: () => false,
				getLoopInterval: () => 100_000_000,
			},
		});
		const result = await autonomyStatusProvider.get(
			runtime,
			memory(otherRoomId, otherUUID, "status?"),
		);
		expect(result.text).toContain("Thinking interval: 1440 minutes");
		expect(result.data).toMatchObject({
			interval: 86_400_000,
			intervalSeconds: 86_400,
		});
	});

	it("translates service failures into an explicitly unavailable status", async () => {
		const failure = new Error("loop probe failed");
		const roomId = otherRoomId;
		const runtime = buildRuntime({
			service: {
				getAutonomousRoomId: () => autonomousRoomId,
				isLoopRunning: () => {
					throw failure;
				},
				getLoopInterval: () => 30_000,
			},
		});
		const result = await autonomyStatusProvider.get(
			runtime,
			memory(roomId, otherUUID, "status?"),
		);
		expect(result.text).toBe("Autonomy status is unavailable.");
		expect(result.data).toMatchObject({
			available: false,
			reason: "autonomy_status_unavailable",
			error: "loop probe failed",
		});
		expect(result.values).toEqual({ autonomyStatusAvailable: false });
		expect(runtime.reportError).toHaveBeenCalledWith(
			"AutonomyStatusProvider.get",
			failure,
			{ roomId },
		);
	});

	it("stringifies non-Error service failures", async () => {
		const runtime = buildRuntime({
			service: {
				getAutonomousRoomId: () => autonomousRoomId,
				isLoopRunning: () => false,
				getLoopInterval: () => {
					throw 7;
				},
			},
		});
		const result = await autonomyStatusProvider.get(
			runtime,
			memory(otherRoomId, otherUUID, "status?"),
		);
		expect(result.data).toMatchObject({
			reason: "autonomy_status_unavailable",
			error: "7",
		});
	});
});
