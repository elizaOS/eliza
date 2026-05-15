import { describe, expect, it, vi } from "vitest";
import {
	type VoiceCancellationListener,
	VoiceCancellationRegistry,
	type VoiceCancellationToken,
	createAbortedVoiceCancellationToken,
	createVoiceCancellationToken,
} from "./voice-cancellation-token";

function newToken(): VoiceCancellationToken {
	return createVoiceCancellationToken({ runId: "turn-1" });
}

describe("createVoiceCancellationToken", () => {
	it("starts active and aborts on demand", () => {
		const token = newToken();
		expect(token.aborted).toBe(false);
		expect(token.reason).toBeNull();
		expect(token.signal.aborted).toBe(false);
		token.abort("barge-in");
		expect(token.aborted).toBe(true);
		expect(token.reason).toBe("barge-in");
		expect(token.signal.aborted).toBe(true);
	});

	it("is idempotent — first reason wins", () => {
		const token = newToken();
		token.abort("barge-in");
		token.abort("timeout");
		expect(token.reason).toBe("barge-in");
	});

	it("fires onAbort listeners synchronously with the recorded reason", () => {
		const token = newToken();
		const seen: string[] = [];
		token.onAbort((r) => seen.push(r));
		token.onAbort((r) => seen.push(`b:${r}`));
		token.abort("eot-revoked");
		expect(seen).toEqual(["eot-revoked", "b:eot-revoked"]);
	});

	it("fires onAbort synchronously even when registered after abort", () => {
		const token = newToken();
		token.abort("user-cancel");
		const late: VoiceCancellationListener = vi.fn();
		token.onAbort(late);
		expect(late).toHaveBeenCalledWith("user-cancel");
	});

	it("unsubscribes cleanly", () => {
		const token = newToken();
		const seen: string[] = [];
		const unsub = token.onAbort((r) => seen.push(r));
		unsub();
		token.abort("barge-in");
		expect(seen).toEqual([]);
	});

	it("listener errors do not block fan-out", () => {
		const token = newToken();
		const seen: string[] = [];
		token.onAbort(() => {
			throw new Error("boom");
		});
		token.onAbort((r) => seen.push(r));
		token.abort("external");
		expect(seen).toEqual(["external"]);
		expect(token.aborted).toBe(true);
	});

	it("threads the optional slot id", () => {
		const token = createVoiceCancellationToken({ runId: "r", slot: 7 });
		expect(token.slot).toBe(7);
	});

	it("aborts when the linked signal aborts (reason=external)", () => {
		const ctrl = new AbortController();
		const token = createVoiceCancellationToken({
			runId: "r",
			linkSignal: ctrl.signal,
		});
		expect(token.aborted).toBe(false);
		ctrl.abort();
		expect(token.aborted).toBe(true);
		expect(token.reason).toBe("external");
	});

	it("aborts immediately when linked to an already-aborted signal", () => {
		const ctrl = new AbortController();
		ctrl.abort();
		const token = createVoiceCancellationToken({
			runId: "r",
			linkSignal: ctrl.signal,
		});
		expect(token.aborted).toBe(true);
		expect(token.reason).toBe("external");
	});
});

describe("createAbortedVoiceCancellationToken", () => {
	it("returns an already-aborted token with the given reason", () => {
		const t = createAbortedVoiceCancellationToken("timeout");
		expect(t.aborted).toBe(true);
		expect(t.reason).toBe("timeout");
		expect(t.signal.aborted).toBe(true);
	});
});

describe("VoiceCancellationRegistry", () => {
	it("arms and exposes the active token per room", () => {
		const reg = new VoiceCancellationRegistry();
		const token = reg.arm("room-a", { runId: "t1" });
		expect(reg.current("room-a")).toBe(token);
		expect(reg.current("room-b")).toBeNull();
	});

	it("aborts the previous token when arming a new one for the same room", () => {
		const reg = new VoiceCancellationRegistry();
		const first = reg.arm("room-a", { runId: "t1" });
		const second = reg.arm("room-a", { runId: "t2" });
		expect(first.aborted).toBe(true);
		expect(first.reason).toBe("external");
		expect(second.aborted).toBe(false);
		expect(reg.current("room-a")).toBe(second);
	});

	it("abort(roomId, reason) trips the live token", () => {
		const reg = new VoiceCancellationRegistry();
		const t = reg.arm("room-a", { runId: "t1" });
		expect(reg.abort("room-a", "barge-in")).toBe(true);
		expect(t.aborted).toBe(true);
		expect(t.reason).toBe("barge-in");
		// Second call returns false (already aborted).
		expect(reg.abort("room-a", "timeout")).toBe(false);
	});

	it("drops the token from active room ids once aborted", () => {
		const reg = new VoiceCancellationRegistry();
		reg.arm("room-a", { runId: "t1" });
		reg.arm("room-b", { runId: "t2" });
		expect(reg.activeRoomIds().sort()).toEqual(["room-a", "room-b"]);
		reg.abort("room-a", "barge-in");
		expect(reg.activeRoomIds()).toEqual(["room-b"]);
	});

	it("abortAll trips every live token", () => {
		const reg = new VoiceCancellationRegistry();
		const a = reg.arm("room-a", { runId: "ta" });
		const b = reg.arm("room-b", { runId: "tb" });
		const aborted = reg.abortAll("external").sort();
		expect(aborted).toEqual(["room-a", "room-b"]);
		expect(a.aborted).toBe(true);
		expect(b.aborted).toBe(true);
	});

	it("clear() drops everything without aborting", () => {
		const reg = new VoiceCancellationRegistry();
		const t = reg.arm("room-a", { runId: "t1" });
		reg.clear();
		expect(reg.current("room-a")).toBeNull();
		// The token itself is not aborted by clear() — caller owns the
		// decision to abort vs simply forget.
		expect(t.aborted).toBe(false);
	});
});
