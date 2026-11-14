import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { expect, test } from "vitest";
import { AgentRuntime } from "../src/runtime";
import { RunTerminalOwner } from "../src/runtime/run-terminal-owner";
import { withRoomDeliverySettlement } from "../src/services/post-delivery-task-tracker";
import type { AppliedEffectReceipt } from "../src/types/effects";
import { EventType, type RunEventPayload } from "../src/types/events";
import type { Memory } from "../src/types/memory";
import type { UUID } from "../src/types/primitives";

const roomId = "11111111-1111-4111-8111-111111111111" as UUID;
const runId = "22222222-2222-4222-8222-222222222222" as UUID;
const message: Memory = {
	id: "33333333-3333-4333-8333-333333333333" as UUID,
	entityId: "44444444-4444-4444-8444-444444444444" as UUID,
	roomId,
	content: { text: "Record the result" },
};

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("joins an admitted terminal subscriber after a sibling rejects", async () => {
	const runtime = new AgentRuntime({
		character: { name: "Run terminal owner" },
		enableBasicCapabilities: false,
		logLevel: "fatal",
	});
	const directory = await mkdtemp(path.join(tmpdir(), "eliza-run-terminal-"));
	const target = path.join(directory, "subscriber-receipt");
	const started = deferred();
	const release = deferred();
	const firstFailure = new Error("terminal subscriber refused");
	const seen: RunEventPayload[] = [];
	const reported: string[] = [];
	runtime.registerEvent(EventType.ERROR_REPORTED, async (event) => {
		reported.push(event.message);
	});
	runtime.registerEvent(EventType.RUN_ENDED, async () => {
		throw firstFailure;
	});
	runtime.registerEvent(EventType.RUN_ENDED, async (event) => {
		seen.push(event);
		started.resolve();
		await release.promise;
		await writeFile(target, event.runId);
	});
	let completed = false;
	const completion = runtime.roomHandlerQueue.withLease(
		roomId,
		async (lease) => {
			const owner = new RunTerminalOwner(
				runtime,
				runId,
				message,
				Date.now(),
				lease,
			);
			const request = owner.request({ status: "completed", effects: [] });
			expect(owner.request({ status: "failed", effects: [] })).toBe(request);
			await request;
			completed = true;
		},
	);
	try {
		await started.promise;
		await setImmediate();
		expect(completed).toBe(false);
		expect(seen.map((event) => event.outcome?.status)).toEqual(["completed"]);
		release.resolve();
		await completion;
		expect(await readFile(target, "utf8")).toBe(runId);
		expect(reported).toContain(firstFailure.message);
	} finally {
		release.resolve();
		await completion;
		await runtime.stop();
		await rm(directory, { recursive: true, force: true });
	}
});

test("keeps the first terminal outcome and skips work after failed delivery", async () => {
	const runtime = new AgentRuntime({
		character: { name: "Run terminal owner" },
		enableBasicCapabilities: false,
		logLevel: "fatal",
	});
	const seen: RunEventPayload[] = [];
	const invoked: string[] = [];
	const failure = new Error("connector persistence failed");
	runtime.registerEvent(EventType.RUN_ENDED, async (event) => {
		seen.push(event);
	});
	const observedAt = "2026-11-10T00:00:00.000Z";
	const receipt: AppliedEffectReceipt = {
		receiptId: "receipt:test-run",
		operation: "fixture.result.record",
		resource: { kind: "fixture.result", id: "result-1" },
		artifacts: [],
		idempotency: { key: "test-run", replayed: false },
		observedAt,
		outcome: "applied",
		commit: { kind: "durable", id: "result-1", committedAt: observedAt },
	};
	try {
		await runtime.roomHandlerQueue.withLease(roomId, async (lease) => {
			const owner = new RunTerminalOwner(
				runtime,
				runId,
				message,
				Date.now(),
				lease,
			);
			owner.recordActionResult({ success: true, effectReceipts: [receipt] });
			await expect(
				withRoomDeliverySettlement(runtime, roomId, lease, async () => {
					owner.trackAfterDelivery("post-turn", async () => {
						invoked.push("post-turn");
					});
					const terminal = owner.request(
						{ status: "failed", effects: [] },
						failure,
					);
					expect(owner.request({ status: "completed", effects: [] })).toBe(
						terminal,
					);
					await owner.track("late", async () => {
						invoked.push("late");
					});
					expect(seen).toHaveLength(0);
					throw failure;
				}),
			).rejects.toBe(failure);
		});
		expect(invoked).toEqual([]);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			runId,
			outcome: { status: "failed", effects: [receipt] },
			error: failure,
		});
	} finally {
		await runtime.stop();
	}
});

test("preserves the first observed event rejection and skips later event names", async () => {
	const runtime = new AgentRuntime({
		character: { name: "Event failure join" },
		enableBasicCapabilities: false,
		logLevel: "fatal",
	});
	const started = deferred();
	const release = deferred();
	const firstRegistered = new Error("first registered, last rejected");
	const firstObserved = new Error("second registered, first rejected");
	let laterEventCalls = 0;
	runtime.registerEvent("fixture:first", async () => {
		started.resolve();
		await release.promise;
		throw firstRegistered;
	});
	runtime.registerEvent("fixture:first", async () => {
		throw firstObserved;
	});
	runtime.registerEvent("fixture:later", async () => {
		laterEventCalls += 1;
	});
	let returned = false;
	const observed = runtime
		.emitEvent(["fixture:first", "fixture:later"], {})
		.then(
			() => {
				returned = true;
				return undefined;
			},
			(error: unknown) => {
				returned = true;
				return error;
			},
		);
	try {
		await started.promise;
		await setImmediate();
		expect(returned).toBe(false);
		release.resolve();
		expect(await observed).toBe(firstObserved);
		expect(laterEventCalls).toBe(0);
	} finally {
		release.resolve();
		await observed;
		await runtime.stop();
	}
});
