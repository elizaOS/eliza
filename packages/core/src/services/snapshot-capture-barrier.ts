/**
 * Coordinates the one-way transition from a writable agent runtime to a
 * quiescent pre-upgrade snapshot. HTTP, WebSocket, and message ingress share
 * one runtime-scoped admission counter so capture cannot race a mutation that
 * was accepted immediately before the drain began.
 */
import { ElizaError } from "../errors.ts";
import type { IAgentRuntime } from "../types/runtime.ts";

export type SnapshotCapturePhase =
	| "accepting"
	| "draining"
	| "capturing"
	| "standby"
	| "failed";

export interface SnapshotCaptureBarrierStatus {
	activeMutations: number;
	failure: string | null;
	phase: SnapshotCapturePhase;
}

export interface SnapshotMutationLease {
	release(): void;
}

function admissionClosedError(phase: SnapshotCapturePhase): ElizaError {
	return new ElizaError(
		`Agent is unavailable while snapshot capture is ${phase}`,
		{
			code: "AGENT_SNAPSHOT_MUTATION_ADMISSION_CLOSED",
			context: { phase },
			severity: "ephemeral",
		},
	);
}

export class SnapshotCaptureBarrier {
	private phase: SnapshotCapturePhase = "accepting";
	private activeMutations = 0;
	private failure: string | null = null;
	private readonly drainWaiters = new Set<() => void>();

	status(): SnapshotCaptureBarrierStatus {
		return {
			activeMutations: this.activeMutations,
			failure: this.failure,
			phase: this.phase,
		};
	}

	admitMutation(): SnapshotMutationLease {
		if (this.phase !== "accepting") {
			throw admissionClosedError(this.phase);
		}
		this.activeMutations += 1;
		let released = false;
		return {
			release: () => {
				if (released) return;
				released = true;
				this.activeMutations -= 1;
				if (this.activeMutations < 0) {
					throw new ElizaError("Snapshot mutation admission underflow", {
						code: "AGENT_SNAPSHOT_BARRIER_INVARIANT",
						severity: "fatal",
					});
				}
				if (this.activeMutations === 0) {
					for (const resolve of this.drainWaiters) resolve();
					this.drainWaiters.clear();
				}
			},
		};
	}

	beginDraining(): void {
		if (this.phase !== "accepting") {
			throw new ElizaError(
				`Snapshot capture cannot begin while phase is ${this.phase}`,
				{
					code: "AGENT_SNAPSHOT_CAPTURE_ALREADY_STARTED",
					context: { phase: this.phase },
					severity: "ephemeral",
				},
			);
		}
		this.phase = "draining";
	}

	async waitForDrain(): Promise<void> {
		if (this.phase !== "draining") {
			throw new ElizaError(
				`Snapshot mutation drain requires draining phase, got ${this.phase}`,
				{
					code: "AGENT_SNAPSHOT_BARRIER_INVARIANT",
					context: { phase: this.phase },
					severity: "fatal",
				},
			);
		}
		if (this.activeMutations === 0) return;
		await new Promise<void>((resolve) => {
			this.drainWaiters.add(resolve);
		});
		if (this.phase !== "draining") {
			throw new ElizaError(
				`Snapshot mutation drain ended while phase is ${this.phase}`,
				{
					code: "AGENT_SNAPSHOT_BARRIER_INVARIANT",
					context: { phase: this.phase },
					severity: "fatal",
				},
			);
		}
	}

	beginCapturing(): void {
		if (this.phase !== "draining" || this.activeMutations !== 0) {
			throw new ElizaError(
				"Snapshot capture requires a fully drained mutation barrier",
				{
					code: "AGENT_SNAPSHOT_BARRIER_INVARIANT",
					context: {
						activeMutations: this.activeMutations,
						phase: this.phase,
					},
					severity: "fatal",
				},
			);
		}
		this.phase = "capturing";
	}

	enterStandby(): void {
		if (this.phase !== "capturing") {
			throw new ElizaError(
				`Snapshot standby requires capturing phase, got ${this.phase}`,
				{
					code: "AGENT_SNAPSHOT_BARRIER_INVARIANT",
					context: { phase: this.phase },
					severity: "fatal",
				},
			);
		}
		this.phase = "standby";
	}

	fail(cause: unknown): void {
		if (this.phase === "standby") {
			throw new ElizaError("A committed snapshot standby cannot fail", {
				code: "AGENT_SNAPSHOT_BARRIER_INVARIANT",
				severity: "fatal",
			});
		}
		this.failure =
			cause instanceof Error ? cause.message : String(cause ?? "unknown");
		this.phase = "failed";
		for (const resolve of this.drainWaiters) resolve();
		this.drainWaiters.clear();
	}
}

const captureBarriers = new WeakMap<object, SnapshotCaptureBarrier>();

export function getSnapshotCaptureBarrier(
	runtime: IAgentRuntime,
): SnapshotCaptureBarrier {
	const key = runtime as object;
	let barrier = captureBarriers.get(key);
	if (!barrier) {
		barrier = new SnapshotCaptureBarrier();
		captureBarriers.set(key, barrier);
	}
	return barrier;
}
