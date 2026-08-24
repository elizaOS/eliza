/**
 * Deterministic unit coverage for the autonomy REST route handlers. Each test
 * invokes the real exported handlers with typed request/response/runtime
 * stand-ins and a mutating autonomy-service fake, covering the 503
 * service-unavailable paths, the legacy service-type fallback, enable/disable/
 * toggle state transitions, interval validation bounds, and the derived status
 * fields without a server or database.
 */
import { describe, expect, test, vi } from "vitest";
import { createMockRuntime } from "../../testing/mock-runtime.ts";
import type {
	Character,
	IAgentRuntime,
	RouteRequest,
	RouteResponse,
	UUID,
} from "../../types/index.ts";
import { autonomyRoutes } from "./routes.ts";
import { AUTONOMY_SERVICE_TYPE, type AutonomyService } from "./service.ts";
import type { AutonomyStatus } from "./types.ts";

const AGENT_ID = "10000000-0000-0000-0000-000000000000" as UUID;
const ROOM_ID = "20000000-0000-0000-0000-000000000000" as UUID;

const ROUTE_CHARACTER: Character = {
	name: "RouteBot",
	bio: [],
	templates: {},
	messageExamples: [],
	postExamples: [],
	topics: [],
	adjectives: [],
	knowledge: [],
	plugins: [],
	secrets: {},
	settings: {},
};

type ServiceStandIn = Pick<
	AutonomyService,
	"getStatus" | "enableAutonomy" | "disableAutonomy" | "setLoopInterval"
>;

/**
 * Build an autonomy-service stand-in backed by real mutable state so every
 * getStatus() call observes the mutations performed by enable/disable/setLoop
 * — the same read-after-write ordering the route handlers rely on.
 */
function autonomyService(
	initial: Partial<AutonomyStatus> = {},
): ServiceStandIn & { state: AutonomyStatus } {
	const state: AutonomyStatus = {
		enabled: false,
		running: false,
		thinking: false,
		interval: 30_000,
		autonomousRoomId: ROOM_ID,
		...initial,
	};
	return {
		state,
		getStatus: vi.fn(() => ({ ...state })),
		enableAutonomy: vi.fn(async () => {
			state.enabled = true;
		}),
		disableAutonomy: vi.fn(async () => {
			state.enabled = false;
		}),
		setLoopInterval: vi.fn(async (ms: number) => {
			state.interval = ms;
		}),
	};
}

function runtimeWithService(
	service: ServiceStandIn | null,
	overrides: Partial<IAgentRuntime> = {},
	serviceType = AUTONOMY_SERVICE_TYPE,
): IAgentRuntime {
	return createMockRuntime({
		agentId: AGENT_ID,
		character: ROUTE_CHARACTER,
		getService: ((name: string) =>
			name === serviceType ? service : null) as IAgentRuntime["getService"],
		...overrides,
	});
}

function mockResponse(): {
	res: RouteResponse;
	json: ReturnType<typeof vi.fn>;
} {
	const res: RouteResponse = {
		status: vi.fn(() => res),
		json: vi.fn(() => res),
		send: vi.fn(() => res),
		end: vi.fn(() => res),
	};
	return { res, json: res.json };
}

function handlerFor(type: string, path: string) {
	const route = autonomyRoutes.find(
		(candidate) => candidate.type === type && candidate.path === path,
	);
	if (!route?.handler) {
		throw new Error(`route ${type} ${path} has no legacy handler`);
	}
	return route.handler;
}

async function invokeGet(path: string, runtime: IAgentRuntime) {
	const { res, json } = mockResponse();
	await handlerFor("GET", path)({} as RouteRequest, res, runtime);
	return { res, json };
}

async function invokePost(
	path: string,
	runtime: IAgentRuntime,
	body?: Record<string, unknown>,
) {
	const { res, json } = mockResponse();
	await handlerFor("POST", path)(
		(body === undefined ? {} : { body }) as RouteRequest,
		res,
		runtime,
	);
	return { res, json };
}

describe("autonomyRoutes registry", () => {
	test("registers the five documented method/path pairs with callable handlers", () => {
		expect(
			autonomyRoutes.map((route) => `${route.type} ${route.path}`),
		).toEqual([
			"GET /autonomy/status",
			"POST /autonomy/enable",
			"POST /autonomy/disable",
			"POST /autonomy/toggle",
			"POST /autonomy/interval",
		]);
		for (const route of autonomyRoutes) {
			expect(typeof route.handler).toBe("function");
		}
	});
});

describe("GET /autonomy/status", () => {
	test("responds 503 with an error payload when no autonomy service exists", async () => {
		const { res, json } = await invokeGet(
			"/autonomy/status",
			runtimeWithService(null),
		);

		expect(res.status).toHaveBeenCalledTimes(1);
		expect(res.status).toHaveBeenCalledWith(503);
		expect(json).toHaveBeenCalledTimes(1);
		expect(json).toHaveBeenCalledWith({
			error: "Autonomy service not available",
		});
	});

	test("falls back to the legacy 'autonomy' service key when the canonical lookup misses", async () => {
		const service = autonomyService({ enabled: true, running: true });

		const { res, json } = await invokeGet(
			"/autonomy/status",
			runtimeWithService(service, {}, "autonomy"),
		);

		expect(res.status).not.toHaveBeenCalled();
		expect(json).toHaveBeenCalledWith({
			success: true,
			data: {
				enabled: true,
				running: true,
				interval: 30_000,
				intervalSeconds: 30,
				autonomousRoomId: ROOM_ID,
				agentId: AGENT_ID,
				characterName: "RouteBot",
			},
		});
	});

	test("derives intervalSeconds by rounding milliseconds and reports runtime identity", async () => {
		const service = autonomyService({ interval: 59_500 });

		const { res, json } = await invokeGet(
			"/autonomy/status",
			runtimeWithService(service),
		);

		expect(res.status).not.toHaveBeenCalled();
		expect(json).toHaveBeenCalledWith({
			success: true,
			data: {
				enabled: false,
				running: false,
				interval: 59_500,
				intervalSeconds: 60,
				autonomousRoomId: ROOM_ID,
				agentId: AGENT_ID,
				characterName: "RouteBot",
			},
		});
	});

	test("falls back to 'Agent' when the character name is empty", async () => {
		const service = autonomyService();
		const runtime = runtimeWithService(service, {
			character: { ...ROUTE_CHARACTER, name: "" },
		});

		const { json } = await invokeGet("/autonomy/status", runtime);

		expect(json).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ characterName: "Agent" }),
			}),
		);
	});
});

describe("POST /autonomy/enable", () => {
	test("responds 503 without touching any service when none exists", async () => {
		const { res, json } = await invokePost(
			"/autonomy/enable",
			runtimeWithService(null),
		);

		expect(res.status).toHaveBeenCalledWith(503);
		expect(json).toHaveBeenCalledWith({
			success: false,
			error: "Autonomy service not available",
		});
	});

	test("enables autonomy and reports the refreshed status", async () => {
		const service = autonomyService({ enabled: false });

		const { res, json } = await invokePost(
			"/autonomy/enable",
			runtimeWithService(service),
		);

		expect(service.enableAutonomy).toHaveBeenCalledTimes(1);
		expect(service.disableAutonomy).not.toHaveBeenCalled();
		expect(res.status).not.toHaveBeenCalled();
		expect(json).toHaveBeenCalledWith({
			success: true,
			message: "Autonomy enabled",
			data: { enabled: true, running: false, interval: 30_000 },
		});
	});
});

describe("POST /autonomy/disable", () => {
	test("responds 503 when no autonomy service exists", async () => {
		const { res, json } = await invokePost(
			"/autonomy/disable",
			runtimeWithService(null),
		);

		expect(res.status).toHaveBeenCalledWith(503);
		expect(json).toHaveBeenCalledWith({
			success: false,
			error: "Autonomy service not available",
		});
	});

	test("disables autonomy and reports the refreshed status", async () => {
		const service = autonomyService({ enabled: true });

		const { res, json } = await invokePost(
			"/autonomy/disable",
			runtimeWithService(service),
		);

		expect(service.disableAutonomy).toHaveBeenCalledTimes(1);
		expect(service.enableAutonomy).not.toHaveBeenCalled();
		expect(res.status).not.toHaveBeenCalled();
		expect(json).toHaveBeenCalledWith({
			success: true,
			message: "Autonomy disabled",
			data: { enabled: false, running: false, interval: 30_000 },
		});
	});
});

describe("POST /autonomy/toggle", () => {
	test("responds 503 when no autonomy service exists", async () => {
		const { res, json } = await invokePost(
			"/autonomy/toggle",
			runtimeWithService(null),
		);

		expect(res.status).toHaveBeenCalledWith(503);
		expect(json).toHaveBeenCalledWith({
			success: false,
			error: "Autonomy service not available",
		});
	});

	test("enables when currently disabled", async () => {
		const service = autonomyService({ enabled: false });

		const { res, json } = await invokePost(
			"/autonomy/toggle",
			runtimeWithService(service),
		);

		expect(service.enableAutonomy).toHaveBeenCalledTimes(1);
		expect(service.disableAutonomy).not.toHaveBeenCalled();
		expect(res.status).not.toHaveBeenCalled();
		expect(json).toHaveBeenCalledWith({
			success: true,
			message: "Autonomy enabled",
			data: { enabled: true, running: false, interval: 30_000 },
		});
	});

	test("disables when currently enabled and reports the new state", async () => {
		const service = autonomyService({ enabled: true });

		const { json } = await invokePost(
			"/autonomy/toggle",
			runtimeWithService(service),
		);

		expect(service.disableAutonomy).toHaveBeenCalledTimes(1);
		expect(service.enableAutonomy).not.toHaveBeenCalled();
		expect(json).toHaveBeenCalledWith({
			success: true,
			message: "Autonomy disabled",
			data: { enabled: false, running: false, interval: 30_000 },
		});
	});
});

describe("POST /autonomy/interval", () => {
	test("responds 503 when no autonomy service exists", async () => {
		const { res, json } = await invokePost(
			"/autonomy/interval",
			runtimeWithService(null),
			{ interval: 10_000 },
		);

		expect(res.status).toHaveBeenCalledWith(503);
		expect(json).toHaveBeenCalledWith({
			success: false,
			error: "Autonomy service not available",
		});
	});

	test.each([
		["a non-number body value", { interval: "45000" }],
		["undefined body value", {}],
		["a value below the lower bound", { interval: 4999 }],
		["a value above the upper bound", { interval: 600_001 }],
	] as const)("rejects %s with 400", async (_label, body) => {
		const service = autonomyService();

		const { res, json } = await invokePost(
			"/autonomy/interval",
			runtimeWithService(service),
			body,
		);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(json).toHaveBeenCalledWith({
			success: false,
			error: "Interval must be a number between 5000ms (5s) and 600000ms (10m)",
		});
		expect(service.setLoopInterval).not.toHaveBeenCalled();
	});

	test("applies an in-range interval and echoes the refreshed cadence", async () => {
		const service = autonomyService({ interval: 30_000 });

		const { res, json } = await invokePost(
			"/autonomy/interval",
			runtimeWithService(service),
			{ interval: 45_000 },
		);

		expect(service.setLoopInterval).toHaveBeenCalledTimes(1);
		expect(service.setLoopInterval).toHaveBeenCalledWith(45_000);
		expect(res.status).not.toHaveBeenCalled();
		expect(json).toHaveBeenCalledWith({
			success: true,
			message: "Interval updated",
			data: { interval: 45_000, intervalSeconds: 45 },
		});
	});

	test.each([5_000, 600_000] as const)(
		"accepts the inclusive bound %s",
		async (bound) => {
			const service = autonomyService();

			const { res, json } = await invokePost(
				"/autonomy/interval",
				runtimeWithService(service),
				{ interval: bound },
			);

			expect(res.status).not.toHaveBeenCalled();
			expect(service.setLoopInterval).toHaveBeenCalledWith(bound);
			expect(json).toHaveBeenCalledWith({
				success: true,
				message: "Interval updated",
				data: {
					interval: bound,
					intervalSeconds: Math.round(bound / 1000),
				},
			});
		},
	);
});
