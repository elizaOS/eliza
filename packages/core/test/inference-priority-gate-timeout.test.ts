import { describe, expect, it } from "vitest";
import {
	InferenceBackgroundWaitTimeoutError,
	InferencePriorityGate,
} from "../src/utils/inference-priority-gate";

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

describe("InferencePriorityGate background wait timer", () => {
	it("does not fail a background waiter at once for a wait past the 32-bit timer limit", async () => {
		const gate = new InferencePriorityGate();
		let releaseHolder!: () => void;
		const holder = new Promise<void>((resolve) => {
			releaseHolder = resolve;
		});
		const holding = gate.runExclusive(
			{ priority: "interactive", label: "holder" },
			() => holder,
		);
		let settled = false;
		const pending = gate.runExclusive(
			{ priority: "background", label: "bg", waitMs: 2 ** 31 },
			async () => "ran",
		);
		void pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		// Node clamps an overflowing setTimeout to 1 ms, so the unfixed
		// waiter fails here instead of waiting.
		await sleep(50);
		expect(settled).toBe(false);
		releaseHolder();
		await expect(pending).resolves.toBe("ran");
		await holding;
	});

	it("does not fail an unbounded background waiter at once", async () => {
		const gate = new InferencePriorityGate();
		let releaseHolder!: () => void;
		const holder = new Promise<void>((resolve) => {
			releaseHolder = resolve;
		});
		const holding = gate.runExclusive(
			{ priority: "interactive", label: "holder" },
			() => holder,
		);
		let settled = false;
		const pending = gate.runExclusive(
			{ priority: "background", label: "bg", waitMs: Infinity },
			async () => "ran",
		);
		void pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await sleep(50);
		expect(settled).toBe(false);
		releaseHolder();
		await expect(pending).resolves.toBe("ran");
		await holding;
	});

	it("still times out a short background wait", async () => {
		const gate = new InferencePriorityGate();
		const holding = gate.runExclusive(
			{ priority: "interactive", label: "holder" },
			() => sleep(200),
		);
		await expect(
			gate.runExclusive(
				{ priority: "background", label: "bg", waitMs: 10 },
				async () => "ran",
			),
		).rejects.toBeInstanceOf(InferenceBackgroundWaitTimeoutError);
		await holding;
	});
});
