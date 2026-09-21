/**
 * Unit coverage for the ERROR_REPORTED emit guard against both context
 * storages it can be built on: the real AsyncLocalStorage-backed storage
 * (exact attribution across awaits, no cross-chain leak) and the synchronous
 * stack fallback used by browser and edge builds (no attribution after an
 * await, so a same-scope repeat while that scope's handlers are still running
 * is what stops a loop). Deterministic; no runtime, no mocks.
 */
import { describe, expect, it } from "vitest";
import {
	createAsyncContextStorage,
	StackAsyncContextStorage,
} from "../plugin-lifecycle";
import {
	ErrorReportEmitGuard,
	type ErrorReportEmitScope,
} from "./error-report-emit-guard";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function held(): { promise: Promise<void>; release: () => void } {
	let release: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

describe("ErrorReportEmitGuard with AsyncLocalStorage", () => {
	it("attributes a report raised after an await inside a handler to the emit it runs in", async () => {
		const guard = new ErrorReportEmitGuard();
		expect(guard.attributesAcrossAwaits).toBe(true);
		let inside: ReturnType<ErrorReportEmitGuard["attribute"]> | undefined;
		await guard.emit("Outer", async () => {
			await tick();
			inside = guard.attribute("Sink");
		});
		expect(inside).toEqual({ kind: "nested", originatingScope: "Outer" });
		expect(guard.attribute("Sink")).toEqual({ kind: "emit" });
		expect(guard.inFlightEmits("Outer")).toBe(0);
	});

	it("does not attribute a report from an unrelated concurrent chain, even for the same scope", async () => {
		const guard = new ErrorReportEmitGuard();
		const gate = held();
		const emit = guard.emit("Outer", async () => {
			await gate.promise;
		});
		await tick();
		expect(guard.inFlightEmits("Outer")).toBe(1);
		expect(guard.attribute("Other")).toEqual({ kind: "emit" });
		expect(guard.attribute("Outer")).toEqual({ kind: "emit" });
		gate.release();
		await emit;
	});

	it("treats a continuation that outlives the emit as a fresh report", async () => {
		const guard = new ErrorReportEmitGuard();
		let detached: Promise<ReturnType<ErrorReportEmitGuard["attribute"]>> =
			Promise.resolve({ kind: "emit" });
		await guard.emit("Outer", async () => {
			detached = new Promise((resolve) =>
				setTimeout(() => resolve(guard.attribute("Sink")), 5),
			);
		});
		expect(await detached).toEqual({ kind: "emit" });
	});

	it("releases the in-flight count when the emit rejects", async () => {
		const guard = new ErrorReportEmitGuard();
		await expect(
			guard.emit("Outer", async () => {
				throw new Error("handler exploded");
			}),
		).rejects.toThrow("handler exploded");
		expect(guard.inFlightEmits("Outer")).toBe(0);
	});
});

describe("ErrorReportEmitGuard with the stack fallback", () => {
	const stackGuard = () =>
		new ErrorReportEmitGuard(
			new StackAsyncContextStorage<ErrorReportEmitScope>(),
		);

	it("stops the re-reporting loop at the first same-scope repeat", async () => {
		const guard = stackGuard();
		expect(guard.attributesAcrossAwaits).toBe(false);
		let handlerInvocations = 0;
		const verdicts: string[] = [];
		// A handler that re-reports after an await, fire-and-forget: the loop
		// shape from #31947. Each nested emit is detached from the handler that
		// raised it, so nothing but the scope links the iterations.
		const handler = async (): Promise<void> => {
			handlerInvocations += 1;
			if (handlerInvocations > 50) return;
			await tick();
			const attribution = guard.attribute("Sink");
			verdicts.push(attribution.kind);
			if (attribution.kind === "emit") void guard.emit("Sink", handler);
		};
		await guard.emit("Outer", handler);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(handlerInvocations).toBe(2);
		expect(verdicts).toEqual(["emit", "repeat-in-flight"]);
		expect(guard.inFlightEmits("Sink")).toBe(0);
		expect(guard.inFlightEmits("Outer")).toBe(0);
	});

	it("leaves a different scope alone while another scope's handlers run", async () => {
		const guard = stackGuard();
		const gate = held();
		const emit = guard.emit("Outer", async () => {
			await gate.promise;
		});
		await tick();
		expect(guard.attribute("Other")).toEqual({ kind: "emit" });
		expect(guard.attribute("Outer")).toEqual({
			kind: "repeat-in-flight",
			inFlight: 1,
		});
		gate.release();
		await emit;
		expect(guard.attribute("Outer")).toEqual({ kind: "emit" });
	});

	it("still attributes a report raised before the handler's first await", () => {
		const guard = stackGuard();
		let inside: ReturnType<ErrorReportEmitGuard["attribute"]> | undefined;
		void guard.emit("Outer", async () => {
			inside = guard.attribute("Sink");
		});
		expect(inside).toEqual({ kind: "nested", originatingScope: "Outer" });
	});

	it("reports the storage kind the default factory chose on this host", () => {
		const storage = createAsyncContextStorage<ErrorReportEmitScope>();
		expect(new ErrorReportEmitGuard(storage).attributesAcrossAwaits).toBe(
			storage.propagatesAcrossAwaits,
		);
	});
});
