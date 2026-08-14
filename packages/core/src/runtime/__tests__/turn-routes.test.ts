/**
 * Integration coverage for the turn-control HTTP contract over the real turn
 * registry and room queue. No model, transport mock, or database is involved.
 */
import { describe, expect, it } from "vitest";
import type { RouteRequest, RouteResponse } from "../../types/plugin";
import type { IAgentRuntime } from "../../types/runtime";
import { RoomHandlerQueue } from "../room-handler-queue";
import { TurnAbortedError, TurnControllerRegistry } from "../turn-controller";
import { TURN_CONTROL_ROUTES } from "../turn-routes";

const ROOM_ID = "00000000-0000-0000-0000-00000000000a";

function deferred() {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve: () => resolve?.() };
}

function responseRecorder(): {
	response: RouteResponse;
	read: () => { status: number | null; body: unknown };
} {
	let status: number | null = null;
	let body: unknown;
	const response: RouteResponse = {
		status(code) {
			status = code;
			return response;
		},
		json(data) {
			body = data;
			return response;
		},
		send(data) {
			body = data;
			return response;
		},
		end() {
			return response;
		},
	};
	return { response, read: () => ({ status, body }) };
}

function abortRouteHandler() {
	const route = TURN_CONTROL_ROUTES.find(
		(candidate) => candidate.path === "/api/turns/:roomId/abort",
	);
	if (!route?.handler) throw new Error("turn abort route is not registered");
	return route.handler;
}

function runtimeFixture() {
	const turnControllers = new TurnControllerRegistry();
	const roomHandlerQueue = new RoomHandlerQueue();
	const runtime = {
		turnControllers,
		roomHandlerQueue,
	} as unknown as IAgentRuntime;
	return { runtime, turnControllers, roomHandlerQueue };
}

function startAbortableOwner(
	turnControllers: TurnControllerRegistry,
	roomHandlerQueue: RoomHandlerQueue,
	cleanupGate: ReturnType<typeof deferred>,
) {
	const started = deferred();
	const abortObserved = deferred();
	const work = roomHandlerQueue.runWith(ROOM_ID, () =>
		turnControllers.runWith(ROOM_ID, async (signal) => {
			started.resolve();
			await new Promise<never>((_resolve, reject) => {
				const onAbort = () => {
					abortObserved.resolve();
					void cleanupGate.promise.then(() =>
						reject(signal.reason ?? new TurnAbortedError("missing reason")),
					);
				};
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			});
		}),
	);
	// The assertions below observe the same rejection after the route settles;
	// attach a side handler now so runtimes do not flag it as unhandled.
	void work.catch(() => undefined);
	return {
		work,
		started: started.promise,
		abortObserved: abortObserved.promise,
	};
}

async function invokeAbortRoute(
	runtime: IAgentRuntime,
	response: RouteResponse,
	body: Record<string, unknown> = { reason: "voice-session-interrupt" },
): Promise<void> {
	await abortRouteHandler()(
		{
			params: { roomId: ROOM_ID },
			body,
		} satisfies RouteRequest,
		response,
		runtime,
	);
}

describe("turn abort route settlement", () => {
	it("does not respond settled until the observed turn and room owner release", async () => {
		const { runtime, turnControllers, roomHandlerQueue } = runtimeFixture();
		const cleanupGate = deferred();
		const active = startAbortableOwner(
			turnControllers,
			roomHandlerQueue,
			cleanupGate,
		);
		await active.started;
		const recorder = responseRecorder();
		let routeReturned = false;
		const routeCall = invokeAbortRoute(runtime, recorder.response).then(() => {
			routeReturned = true;
		});
		await active.abortObserved;
		await Promise.resolve();
		expect(routeReturned).toBe(false);
		expect(roomHandlerQueue.pendingFor(ROOM_ID)).toBe(1);

		cleanupGate.resolve();
		await routeCall;
		await expect(active.work).rejects.toBeInstanceOf(TurnAbortedError);
		expect(recorder.read()).toEqual({
			status: 200,
			body: {
				aborted: true,
				observed: true,
				settled: true,
				active: false,
				queuePending: 0,
				roomId: ROOM_ID,
				reason: "voice-session-interrupt",
			},
		});
		await expect(
			roomHandlerQueue.runWith(ROOM_ID, async () => "replacement-started"),
		).resolves.toBe("replacement-started");
	});

	it("reports a pre-registration room owner as unobserved and unsettled", async () => {
		const { runtime, roomHandlerQueue } = runtimeFixture();
		const ownerStarted = deferred();
		const ownerGate = deferred();
		const owner = roomHandlerQueue.runWith(ROOM_ID, async () => {
			ownerStarted.resolve();
			await ownerGate.promise;
		});
		await ownerStarted.promise;

		const recorder = responseRecorder();
		await invokeAbortRoute(runtime, recorder.response);
		expect(recorder.read()).toEqual({
			status: 200,
			body: {
				aborted: false,
				observed: false,
				settled: false,
				active: false,
				queuePending: 1,
				roomId: ROOM_ID,
				reason: "voice-session-interrupt",
			},
		});

		ownerGate.resolve();
		await owner;
	});

	it("keeps an absent exact id pending until late ingress settles", async () => {
		const { runtime, turnControllers } = runtimeFixture();
		const recorder = responseRecorder();
		let routeReturned = false;
		const route = invokeAbortRoute(runtime, recorder.response, {
			reason: "voice-session-interrupt",
			clientMessageId: "late-request",
		}).then(() => {
			routeReturned = true;
		});
		await Promise.resolve();
		expect(routeReturned).toBe(false);

		const late = turnControllers.registerRequestAdmission(
			ROOM_ID,
			"late-request",
		);
		expect(late.signal.aborted).toBe(true);
		late.markIngressCommitted();
		late.finish();
		await route;
		expect(recorder.read()).toEqual({
			status: 200,
			body: {
				requestAborted: false,
				requestObserved: false,
				requestArmed: true,
				requestArmRejected: false,
				requestIngressState: "committed",
				requestIngressFailure: null,
				requestSettled: true,
				aborted: false,
				observed: false,
				settled: false,
				active: false,
				queuePending: 0,
				roomId: ROOM_ID,
				clientMessageId: "late-request",
				reason: "voice-session-interrupt",
			},
		});
		const next = turnControllers.registerRequestAdmission(
			ROOM_ID,
			"replacement-request",
		);
		expect(next.signal.aborted).toBe(false);
		next.finish();
	});

	it("waits for exact active request settlement without room-wide abort", async () => {
		const { runtime, turnControllers } = runtimeFixture();
		const target = turnControllers.registerRequestAdmission(
			ROOM_ID,
			"target-request",
		);
		const newer = turnControllers.registerRequestAdmission(
			ROOM_ID,
			"newer-request",
		);
		const recorder = responseRecorder();
		let routeReturned = false;
		const routeCall = invokeAbortRoute(runtime, recorder.response, {
			reason: "voice-session-interrupt",
			clientMessageId: "target-request",
		}).then(() => {
			routeReturned = true;
		});
		expect(target.signal.aborted).toBe(true);
		expect(newer.signal.aborted).toBe(false);
		await Promise.resolve();
		expect(routeReturned).toBe(false);

		target.markIngressCommitted();
		target.finish();
		await routeCall;
		expect(recorder.read()).toEqual({
			status: 200,
			body: {
				requestAborted: true,
				requestObserved: true,
				requestArmed: false,
				requestArmRejected: false,
				requestIngressState: "committed",
				requestIngressFailure: null,
				requestSettled: true,
				aborted: false,
				observed: false,
				settled: false,
				active: false,
				queuePending: 0,
				roomId: ROOM_ID,
				clientMessageId: "target-request",
				reason: "voice-session-interrupt",
			},
		});
		expect(newer.signal.aborted).toBe(false);
		newer.finish();
	});

	it("bounds an exact abort response when request cleanup does not finish", async () => {
		const { runtime, turnControllers } = runtimeFixture();
		const admission = turnControllers.registerRequestAdmission(
			ROOM_ID,
			"hung-request",
		);
		const recorder = responseRecorder();
		const startedAt = Date.now();
		await invokeAbortRoute(runtime, recorder.response, {
			reason: "voice-session-interrupt",
			clientMessageId: "hung-request",
		});
		const elapsedMs = Date.now() - startedAt;

		expect(elapsedMs).toBeGreaterThanOrEqual(650);
		expect(elapsedMs).toBeLessThan(1_500);
		expect(admission.signal.aborted).toBe(true);
		expect(recorder.read()).toEqual({
			status: 200,
			body: {
				requestAborted: true,
				requestObserved: true,
				requestArmed: false,
				requestArmRejected: false,
				requestIngressState: "pending",
				requestIngressFailure: null,
				requestSettled: false,
				aborted: false,
				observed: false,
				settled: false,
				active: false,
				queuePending: 0,
				roomId: ROOM_ID,
				clientMessageId: "hung-request",
				reason: "voice-session-interrupt",
			},
		});
		admission.finish();
	});

	it("rejects malformed exact request ids before creating a tombstone", async () => {
		const { runtime } = runtimeFixture();
		for (const clientMessageId of ["", "   ", "x".repeat(129), 42]) {
			const recorder = responseRecorder();
			await invokeAbortRoute(runtime, recorder.response, { clientMessageId });
			expect(recorder.read()).toEqual({
				status: 400,
				body: {
					error:
						"clientMessageId must be a non-empty string of at most 128 characters",
				},
			});
		}
	});

	it("returns bounded unsettled status when aborted work ignores cancellation", async () => {
		const { runtime, turnControllers, roomHandlerQueue } = runtimeFixture();
		const cleanupGate = deferred();
		const active = startAbortableOwner(
			turnControllers,
			roomHandlerQueue,
			cleanupGate,
		);
		await active.started;
		const recorder = responseRecorder();
		const startedAt = Date.now();
		await invokeAbortRoute(runtime, recorder.response);
		const elapsedMs = Date.now() - startedAt;

		expect(elapsedMs).toBeGreaterThanOrEqual(650);
		expect(elapsedMs).toBeLessThan(1_500);
		expect(recorder.read()).toEqual({
			status: 200,
			body: {
				aborted: true,
				observed: true,
				settled: false,
				active: true,
				queuePending: 1,
				roomId: ROOM_ID,
				reason: "voice-session-interrupt",
			},
		});

		cleanupGate.resolve();
		await expect(active.work).rejects.toBeInstanceOf(TurnAbortedError);
	});
});
