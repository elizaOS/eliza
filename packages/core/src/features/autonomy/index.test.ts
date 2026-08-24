/**
 * Pins for the features/autonomy entry barrel. The bundle-safety anchor the
 * barrel writes at import time must retain every re-exported binding under
 * its FEATURES_AUTONOMY_INDEX key with identities matching direct leaf
 * imports, and the exported actions, routes, and providers must behave as
 * live implementations when driven through a minimal fake autonomy service.
 */
import { describe, expect, it, vi } from "vitest";
import type {
	IAgentRuntime,
	Memory,
	RouteRequest,
	RouteResponse,
} from "../../types";
import {
	disableAutonomousModeAction as leafDisableAction,
	enableAutonomousModeAction as leafEnableAction,
	escalateAction as leafEscalateAction,
} from "./action";
import * as autonomyEntry from "./index";
import {
	adminChatProvider as leafAdminChatProvider,
	autonomyStatusProvider as leafStatusProvider,
} from "./providers";
import { autonomyRoutes as leafRoutes } from "./routes";
import type { AutonomyService } from "./service";
import {
	AutonomyService as leafAutonomyServiceClass,
	AUTONOMY_SERVICE_TYPE as leafServiceType,
	AUTONOMY_TASK_NAME as leafTaskName,
	AUTONOMY_TASK_TAGS as leafTaskTags,
} from "./service";

const ANCHOR_KEY = "__bundle_safety_FEATURES_AUTONOMY_INDEX__";

const AGENT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const AUTONOMOUS_ROOM_ID = "bbbbbbbb-0000-4000-8000-000000000002";
const OTHER_ROOM_ID = "bbbbbbbb-0000-4000-8000-000000000003";
const MESSAGE_ID = "cccccccc-0000-4000-8000-000000000004";
const ADMIN_USER_ID = "admin-operator";

type ServiceState = {
	enabled: boolean;
	enableCalls: number;
	disableCalls: number;
	running: boolean;
	thinking: boolean;
	intervalMs: number;
};

function makeStatefulService(startEnabled = false): {
	service: AutonomyService;
	state: ServiceState;
} {
	const state: ServiceState = {
		enabled: startEnabled,
		enableCalls: 0,
		disableCalls: 0,
		running: false,
		thinking: false,
		intervalMs: 30_000,
	};
	const service = {
		getAutonomousRoomId: () => AUTONOMOUS_ROOM_ID,
		isLoopRunning: () => state.running,
		getLoopInterval: () => state.intervalMs,
		setLoopInterval: (ms: number) => {
			state.intervalMs = ms;
		},
		getStatus: () => ({
			enabled: state.enabled,
			running: state.running,
			thinking: state.thinking,
			interval: state.intervalMs,
			autonomousRoomId: AUTONOMOUS_ROOM_ID,
		}),
		enableAutonomy: async () => {
			state.enableCalls += 1;
			state.enabled = true;
			state.running = true;
		},
		disableAutonomy: async () => {
			state.disableCalls += 1;
			state.enabled = false;
			state.running = false;
		},
	};
	return { service: service as unknown as AutonomyService, state };
}

function makeRuntime(service: unknown): IAgentRuntime {
	return {
		agentId: AGENT_ID,
		character: {},
		enableAutonomy: false,
		getSetting: vi.fn(() => ADMIN_USER_ID),
		getService: vi.fn(() => service),
		createMemory: vi.fn(async () => {}),
		reportError: vi.fn(),
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
	} as unknown as IAgentRuntime;
}

function makeMessage(roomId: string): Memory {
	return {
		id: MESSAGE_ID,
		entityId: AGENT_ID,
		roomId,
		content: { text: "autonomous thought", channelType: "dm" },
		createdAt: Date.now(),
	} as unknown as Memory;
}

function makeRes(): {
	res: RouteResponse;
	calls: { status: number | null; body: unknown };
} {
	const calls: { status: number | null; body: unknown } = {
		status: null,
		body: undefined,
	};
	const res = {
		status(code: number) {
			calls.status = code;
			return res;
		},
		json(body: unknown) {
			calls.body = body;
			return res;
		},
		send: () => res,
		end: () => res,
	};
	return { res: res as unknown as RouteResponse, calls };
}

function makeReq(body?: Record<string, unknown>): RouteRequest {
	return body ? ({ body } as unknown as RouteRequest) : {};
}

function routeHandler(path: string) {
	const found = autonomyEntry.autonomyRoutes.find((r) => r.path === path);
	if (!found?.handler) {
		throw new Error(`route ${path} has no legacy handler`);
	}
	return found.handler;
}

describe("features/autonomy entry barrel", () => {
	it("retains every re-exported binding in its import-time bundle-safety anchor", () => {
		const anchor = (globalThis as Record<string, unknown>)[ANCHOR_KEY];
		expect(Array.isArray(anchor)).toBe(true);
		const values = anchor as unknown[];
		expect(values).toHaveLength(10);
		expect(values).toContain(leafEscalateAction);
		expect(values).toContain(leafEnableAction);
		expect(values).toContain(leafDisableAction);
		expect(values).toContain(leafAdminChatProvider);
		expect(values).toContain(leafStatusProvider);
		expect(values).toContain(leafRoutes);
		expect(values).toContain(leafServiceType);
		expect(values).toContain(leafTaskName);
		expect(values).toContain(leafTaskTags);
		expect(values).toContain(leafAutonomyServiceClass);
	});

	it("resolves each documented export to its leaf-module binding", () => {
		expect(autonomyEntry.escalateAction).toBe(leafEscalateAction);
		expect(autonomyEntry.enableAutonomousModeAction).toBe(leafEnableAction);
		expect(autonomyEntry.disableAutonomousModeAction).toBe(leafDisableAction);
		expect(autonomyEntry.adminChatProvider).toBe(leafAdminChatProvider);
		expect(autonomyEntry.autonomyStatusProvider).toBe(leafStatusProvider);
		expect(autonomyEntry.autonomyRoutes).toBe(leafRoutes);
		expect(autonomyEntry.AutonomyService).toBe(leafAutonomyServiceClass);
		expect(autonomyEntry.AUTONOMY_SERVICE_TYPE).toBe(leafServiceType);
		expect(autonomyEntry.AUTONOMY_TASK_NAME).toBe(leafTaskName);
		expect(autonomyEntry.AUTONOMY_TASK_TAGS).toBe(leafTaskTags);
	});
});

describe("autonomy actions through the entry", () => {
	it("ENABLE_AUTONOMOUS_MODE enables the loop and reports single-delivery success", async () => {
		const { service, state } = makeStatefulService();
		const runtime = makeRuntime(service);
		const callback = vi.fn(async () => {});

		const result = await autonomyEntry.enableAutonomousModeAction.handler(
			runtime,
			makeMessage(OTHER_ROOM_ID),
			undefined,
			undefined,
			callback,
		);

		expect(result.success).toBe(true);
		expect(result.text).toBe("Autonomous mode enabled.");
		expect(result.turnComplete).toBe(true);
		expect(result.data).toMatchObject({
			actionName: "ENABLE_AUTONOMOUS_MODE",
			enabled: true,
			running: true,
			interval: 30_000,
		});
		expect(state.enableCalls).toBe(1);
		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({ text: "Autonomous mode enabled." }),
		);
	});

	it("DISABLE_AUTONOMOUS_MODE stops the loop through the resolved service", async () => {
		const { service, state } = makeStatefulService(true);
		const runtime = makeRuntime(service);

		const result = await autonomyEntry.disableAutonomousModeAction.handler(
			runtime,
			makeMessage(OTHER_ROOM_ID),
		);

		expect(result.success).toBe(true);
		expect(result.text).toBe("Autonomous mode disabled.");
		expect(result.data).toMatchObject({
			actionName: "DISABLE_AUTONOMOUS_MODE",
			enabled: false,
			running: false,
		});
		expect(state.disableCalls).toBe(1);
	});

	it("returns an explicit unavailable result and fails validation without a service", async () => {
		const runtime = makeRuntime(null);
		const message = makeMessage(OTHER_ROOM_ID);

		await expect(
			autonomyEntry.enableAutonomousModeAction.validate(runtime, message),
		).resolves.toBe(false);

		const result = await autonomyEntry.disableAutonomousModeAction.handler(
			runtime,
			message,
		);
		expect(result.success).toBe(false);
		expect(result.text).toBe("Autonomy service not available");
		expect(result.data).toMatchObject({
			actionName: "DISABLE_AUTONOMOUS_MODE",
			errorCode: "autonomy_service_unavailable",
		});
	});

	it("still resolves the service under the legacy 'autonomy' name", async () => {
		const { service } = makeStatefulService();
		const runtime = makeRuntime(service);
		(
			runtime.getService as unknown as ReturnType<typeof vi.fn>
		).mockImplementation((name: string) =>
			name === "autonomy" ? service : null,
		);

		await expect(
			autonomyEntry.enableAutonomousModeAction.validate(
				runtime,
				makeMessage(OTHER_ROOM_ID),
			),
		).resolves.toBe(true);

		const result = await autonomyEntry.enableAutonomousModeAction.handler(
			runtime,
			makeMessage(OTHER_ROOM_ID),
		);
		expect(result.success).toBe(true);
	});

	it("gates ESCALATE validation on service, autonomous room, and configured admin", async () => {
		const missingAdmin = makeRuntime(makeStatefulService().service);
		(
			missingAdmin.getSetting as unknown as ReturnType<typeof vi.fn>
		).mockReturnValue(undefined);

		await expect(
			autonomyEntry.escalateAction.validate(
				makeRuntime(null),
				makeMessage(AUTONOMOUS_ROOM_ID),
			),
		).resolves.toBe(false);
		await expect(
			autonomyEntry.escalateAction.validate(
				makeRuntime(makeStatefulService().service),
				makeMessage(OTHER_ROOM_ID),
			),
		).resolves.toBe(false);
		await expect(
			autonomyEntry.escalateAction.validate(
				missingAdmin,
				makeMessage(AUTONOMOUS_ROOM_ID),
			),
		).resolves.toBe(false);
		await expect(
			autonomyEntry.escalateAction.validate(
				makeRuntime(makeStatefulService().service),
				makeMessage(AUTONOMOUS_ROOM_ID),
			),
		).resolves.toBe(true);
	});

	it("ESCALATE admin delivers the message memory into the agent room", async () => {
		const { service } = makeStatefulService();
		const runtime = makeRuntime(service);
		const callback = vi.fn(async () => {});
		const message = makeMessage(AUTONOMOUS_ROOM_ID);

		const result = await autonomyEntry.escalateAction.handler(
			runtime,
			message,
			undefined,
			{ parameters: { message: "Need human help" } },
			callback,
		);

		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({
			adminUserId: ADMIN_USER_ID,
			targetRoomId: AGENT_ID,
			messageContent: "Need human help",
			sent: true,
		});
		const stored = (runtime.createMemory as unknown as ReturnType<typeof vi.fn>)
			.mock.calls[0][0] as Memory;
		expect(stored.roomId).toBe(AGENT_ID);
		expect(stored.entityId).toBe(AGENT_ID);
		expect(stored.content).toMatchObject({
			text: "Need human help",
			source: "autonomy-to-admin",
		});
		expect(callback).toHaveBeenCalledOnce();
	});

	it("ESCALATE owner target reports an explicit unsupported-target failure", async () => {
		const runtime = makeRuntime(null);

		const result = await autonomyEntry.escalateAction.handler(
			runtime,
			makeMessage(AUTONOMOUS_ROOM_ID),
			undefined,
			{ parameters: { action: "owner" } },
		);

		expect(result.success).toBe(false);
		expect(String(result.text)).toContain("owner");
		expect(result.data).toMatchObject({
			errorCode: "unsupported_escalation_target",
		});
	});
});

describe("autonomy routes through the entry", () => {
	it("GET /autonomy/status answers 503 without a service", async () => {
		const runtime = makeRuntime(null);
		const { res, calls } = makeRes();

		await routeHandler("/autonomy/status")(makeReq(), res, runtime);

		expect(calls.status).toBe(503);
		expect(calls.body).toMatchObject({
			error: "Autonomy service not available",
		});
	});

	it("GET /autonomy/status reports live status with the character-name fallback", async () => {
		const { service } = makeStatefulService(true);
		const runtime = makeRuntime(service);
		const { res, calls } = makeRes();

		await routeHandler("/autonomy/status")(makeReq(), res, runtime);

		expect(calls.status).toBeNull();
		expect(calls.body).toMatchObject({
			success: true,
			data: {
				enabled: true,
				running: false,
				interval: 30_000,
				intervalSeconds: 30,
				autonomousRoomId: AUTONOMOUS_ROOM_ID,
				agentId: AGENT_ID,
				characterName: "Agent",
			},
		});
	});

	it("POST /autonomy/toggle flips a disabled service on", async () => {
		const { service, state } = makeStatefulService(false);
		const runtime = makeRuntime(service);
		const { res, calls } = makeRes();

		await routeHandler("/autonomy/toggle")(makeReq(), res, runtime);

		expect(state.enableCalls).toBe(1);
		expect(calls.body).toMatchObject({
			success: true,
			message: "Autonomy enabled",
			data: { enabled: true },
		});
	});

	it("POST /autonomy/toggle flips an enabled service off", async () => {
		const { service, state } = makeStatefulService(true);
		const runtime = makeRuntime(service);
		const { res, calls } = makeRes();

		await routeHandler("/autonomy/toggle")(makeReq(), res, runtime);

		expect(state.disableCalls).toBe(1);
		expect(calls.body).toMatchObject({
			success: true,
			message: "Autonomy disabled",
			data: { enabled: false },
		});
	});

	it.each([
		["missing value", undefined],
		["non-numeric value", "9000"],
		["below the floor", 4999],
		["above the ceiling", 600_001],
	])(
		"POST /autonomy/interval rejects %s with 400",
		async (_label, interval) => {
			const { service, state } = makeStatefulService();
			const runtime = makeRuntime(service);
			const { res, calls } = makeRes();

			await routeHandler("/autonomy/interval")(
				makeReq({ interval }),
				res,
				runtime,
			);

			expect(calls.status).toBe(400);
			expect(String((calls.body as { error: string }).error)).toContain(
				"between 5000ms",
			);
			expect(state.intervalMs).toBe(30_000);
		},
	);

	it("POST /autonomy/interval applies an in-range value", async () => {
		const { service, state } = makeStatefulService();
		const runtime = makeRuntime(service);
		const { res, calls } = makeRes();

		await routeHandler("/autonomy/interval")(
			makeReq({ interval: 60_000 }),
			res,
			runtime,
		);

		expect(calls.status).toBeNull();
		expect(calls.body).toMatchObject({
			success: true,
			data: { interval: 60_000, intervalSeconds: 60 },
		});
		expect(state.intervalMs).toBe(60_000);
	});
});

describe("autonomy providers through the entry", () => {
	it("AUTONOMY_STATUS reports a running loop outside the autonomous room", async () => {
		const { service, state } = makeStatefulService();
		state.running = true;
		state.thinking = true;
		const runtime = makeRuntime(service);
		(runtime.getService as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
			service,
		);

		const result = await autonomyEntry.autonomyStatusProvider.get(
			runtime,
			makeMessage(OTHER_ROOM_ID),
		);

		expect(result.text).toContain("running autonomously");
		expect(result.data).toMatchObject({
			autonomyEnabled: false,
			serviceRunning: true,
			status: "running",
		});
		expect(result.values).toMatchObject({
			autonomyRunning: true,
			autonomyIntervalSeconds: 30,
		});
	});

	it("AUTONOMY_STATUS clamps oversized intervals to the one-day maximum", async () => {
		const { service, state } = makeStatefulService();
		state.intervalMs = 25 * 60 * 60 * 1000;
		const runtime = makeRuntime(service);
		(runtime.getService as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
			service,
		);

		const result = await autonomyEntry.autonomyStatusProvider.get(
			runtime,
			makeMessage(OTHER_ROOM_ID),
		);

		expect(result.data).toMatchObject({
			interval: 24 * 60 * 60 * 1000,
			intervalSeconds: 86_400,
			status: "disabled",
		});
	});

	it("both providers degrade to explicit unavailability without the service", async () => {
		const runtime = makeRuntime(null);
		const message = makeMessage(OTHER_ROOM_ID);

		const statusResult = await autonomyEntry.autonomyStatusProvider.get(
			runtime,
			message,
		);
		const adminResult = await autonomyEntry.adminChatProvider.get(
			runtime,
			message,
		);

		expect(statusResult.data).toMatchObject({
			available: false,
			reason: "autonomy_service_unavailable",
		});
		expect(adminResult.data).toMatchObject({
			available: false,
			reason: "autonomy_service_unavailable",
		});
	});

	it("ADMIN_CHAT_HISTORY stays out of non-autonomous rooms", async () => {
		const { service } = makeStatefulService();
		const runtime = makeRuntime(service);
		(runtime.getService as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
			service,
		);

		const result = await autonomyEntry.adminChatProvider.get(
			runtime,
			makeMessage(OTHER_ROOM_ID),
		);

		expect(result.data).toMatchObject({
			available: false,
			reason: "not_autonomous_room",
		});
	});
});
