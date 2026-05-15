import { describe, expect, it, vi } from "vitest";
import {
	type CoordinatorRuntime,
	VoiceCancellationCoordinator,
} from "./cancellation-coordinator";

type RuntimeEvent = Parameters<
	Parameters<CoordinatorRuntime["turnControllers"]["onEvent"]>[0]
>[0];

/** Tiny fake matching the runtime structural surface. */
function makeFakeRuntime(): CoordinatorRuntime & {
	emitEvent(event: RuntimeEvent): void;
	abortCalls: Array<{ roomId: string; reason: string }>;
} {
	const listeners = new Set<(e: RuntimeEvent) => void>();
	const abortCalls: Array<{ roomId: string; reason: string }> = [];
	return {
		turnControllers: {
			abortTurn(roomId, reason) {
				abortCalls.push({ roomId, reason });
				return true;
			},
			onEvent(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
		emitEvent(event) {
			for (const l of listeners) l(event);
		},
		abortCalls,
	};
}

describe("VoiceCancellationCoordinator — barge-in fan-out", () => {
	it("arming a turn returns a live token tied to the room", () => {
		const rt = makeFakeRuntime();
		const c = new VoiceCancellationCoordinator({ runtime: rt });
		const token = c.armTurn({ roomId: "r1", runId: "t1" });
		expect(token.aborted).toBe(false);
		expect(c.current("r1")).toBe(token);
		expect(c.armedRoomIds()).toEqual(["r1"]);
	});

	it("bargeIn aborts the token, fires runtime.abortTurn, slotAbort, ttsStop", () => {
		const rt = makeFakeRuntime();
		const slotAbort = vi.fn();
		const ttsStop = vi.fn();
		const c = new VoiceCancellationCoordinator({
			runtime: rt,
			slotAbort,
			ttsStop,
		});
		const token = c.armTurn({ roomId: "r1", runId: "t1", slot: 3 });

		const ok = c.bargeIn("r1");
		expect(ok).toBe(true);
		expect(token.aborted).toBe(true);
		expect(token.reason).toBe("barge-in");
		expect(rt.abortCalls).toEqual([{ roomId: "r1", reason: "barge-in" }]);
		expect(slotAbort).toHaveBeenCalledWith(3, "barge-in");
		expect(ttsStop).toHaveBeenCalledWith("barge-in");
	});

	it("does NOT call slotAbort when no slot was registered on the turn", () => {
		const rt = makeFakeRuntime();
		const slotAbort = vi.fn();
		const c = new VoiceCancellationCoordinator({ runtime: rt, slotAbort });
		c.armTurn({ roomId: "r1", runId: "t1" });
		c.bargeIn("r1");
		expect(slotAbort).not.toHaveBeenCalled();
	});

	it("revokeEot aborts with reason=eot-revoked", () => {
		const rt = makeFakeRuntime();
		const c = new VoiceCancellationCoordinator({ runtime: rt });
		const token = c.armTurn({ roomId: "r1", runId: "t1" });
		c.revokeEot("r1");
		expect(token.reason).toBe("eot-revoked");
		expect(rt.abortCalls).toEqual([{ roomId: "r1", reason: "eot-revoked" }]);
	});

	it("re-arming a room aborts the previous token (reason=external)", () => {
		const rt = makeFakeRuntime();
		const c = new VoiceCancellationCoordinator({ runtime: rt });
		const first = c.armTurn({ roomId: "r1", runId: "t1" });
		const second = c.armTurn({ roomId: "r1", runId: "t2" });
		expect(first.aborted).toBe(true);
		expect(first.reason).toBe("external");
		expect(second.aborted).toBe(false);
	});

	it("propagates runtime-driven aborts into the voice token", () => {
		const rt = makeFakeRuntime();
		const c = new VoiceCancellationCoordinator({ runtime: rt });
		const token = c.armTurn({ roomId: "r1", runId: "t1" });
		rt.emitEvent({ type: "aborted", roomId: "r1", reason: "app-pause" });
		expect(token.aborted).toBe(true);
		expect(token.reason).toBe("external");
	});

	it("propagates runtime aborts with known voice reasons preserving the reason", () => {
		const rt = makeFakeRuntime();
		const c = new VoiceCancellationCoordinator({ runtime: rt });
		const token = c.armTurn({ roomId: "r1", runId: "t1" });
		rt.emitEvent({ type: "aborted", roomId: "r1", reason: "voice-barge-in" });
		expect(token.reason).toBe("barge-in");
	});

	it("ignores runtime aborts for other rooms", () => {
		const rt = makeFakeRuntime();
		const c = new VoiceCancellationCoordinator({ runtime: rt });
		const tokenA = c.armTurn({ roomId: "rA", runId: "tA" });
		const tokenB = c.armTurn({ roomId: "rB", runId: "tB" });
		rt.emitEvent({ type: "aborted", roomId: "rA", reason: "x" });
		expect(tokenA.aborted).toBe(true);
		expect(tokenB.aborted).toBe(false);
	});

	it("dispose tears down every active turn", () => {
		const rt = makeFakeRuntime();
		const c = new VoiceCancellationCoordinator({ runtime: rt });
		const a = c.armTurn({ roomId: "rA", runId: "tA" });
		const b = c.armTurn({ roomId: "rB", runId: "tB" });
		c.dispose();
		expect(a.aborted).toBe(true);
		expect(b.aborted).toBe(true);
		expect(c.armedRoomIds()).toEqual([]);
	});

	it("idempotent abort — second bargeIn is a no-op", () => {
		const rt = makeFakeRuntime();
		const slotAbort = vi.fn();
		const c = new VoiceCancellationCoordinator({ runtime: rt, slotAbort });
		c.armTurn({ roomId: "r1", runId: "t1", slot: 0 });
		expect(c.bargeIn("r1")).toBe(true);
		expect(c.bargeIn("r1")).toBe(false);
		// slotAbort called exactly once for the first abort
		expect(slotAbort).toHaveBeenCalledTimes(1);
	});

	it("listener errors do not block fan-out", () => {
		const rt = makeFakeRuntime();
		// First fan-out callback throws; ttsStop must still fire.
		const ttsStop = vi.fn();
		const slotAbort = vi.fn(() => {
			throw new Error("slot-abort transport failed");
		});
		const c = new VoiceCancellationCoordinator({
			runtime: rt,
			slotAbort,
			ttsStop,
		});
		c.armTurn({ roomId: "r1", runId: "t1", slot: 4 });
		c.bargeIn("r1");
		expect(slotAbort).toHaveBeenCalled();
		expect(ttsStop).toHaveBeenCalled();
		expect(rt.abortCalls.length).toBe(1);
	});
});
