/**
 * Tracks work intentionally moved past connector delivery so runtime shutdown,
 * tests, and latency telemetry can wait for real quiescence. Tasks remain
 * failure-observable through `runtime.reportError`; normal shutdown drains them
 * before services and the database disappear, while fast shutdown stays fast.
 */
import type { IAgentRuntime } from "../types/runtime.ts";

type TrackableRuntime = Pick<IAgentRuntime, "agentId" | "reportError">;

const pendingByRuntime = new WeakMap<object, Set<Promise<void>>>();

function pendingSet(runtime: TrackableRuntime): Set<Promise<void>> {
	const identity = runtime as object;
	let pending = pendingByRuntime.get(identity);
	if (!pending) {
		pending = new Set();
		pendingByRuntime.set(identity, pending);
	}
	return pending;
}

export function trackPostDeliveryTask(
	runtime: TrackableRuntime,
	label: string,
	task: () => Promise<unknown>,
): Promise<void> {
	const pending = pendingSet(runtime);
	const promise = Promise.resolve()
		.then(task)
		.then(() => undefined)
		.catch((error) => {
			// error-policy:J1 The detached task boundary reports the real failure;
			// connector delivery has already succeeded and cannot be rolled back.
			runtime.reportError("PostDeliveryTask", error, {
				agentId: runtime.agentId,
				label,
			});
		})
		.finally(() => {
			pending.delete(promise);
			if (pending.size === 0) {
				pendingByRuntime.delete(runtime as object);
			}
		});
	pending.add(promise);
	return promise;
}

export function pendingPostDeliveryTaskCount(
	runtime: TrackableRuntime,
): number {
	return pendingByRuntime.get(runtime as object)?.size ?? 0;
}

export async function drainPostDeliveryTasks(
	runtime: TrackableRuntime,
): Promise<number> {
	let drained = 0;
	while (true) {
		const pending = pendingByRuntime.get(runtime as object);
		if (!pending || pending.size === 0) return drained;
		const batch = [...pending];
		drained += batch.length;
		await Promise.allSettled(batch);
	}
}
