/**
 * InferencePriorityGate — single-lane local inference scheduling (#11914).
 *
 * The regression the gate exists for: an on-device background agent job holds
 * the model lane for minutes and self-queues, starving interactive chat turns.
 * These tests instrument the lock directly (the "host test with the lock
 * instrumented" the issue calls for): with a long background job mid-flight
 * and more background work queued, an interactive turn completes within its
 * envelope — the current holder's remainder plus its own runtime — instead of
 * waiting behind the background backlog.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
	applyBackgroundInferenceBudget,
	clampBackgroundPrompt,
	getInferencePriorityGate,
	InferenceBackgroundWaitTimeoutError,
	InferencePriorityGate,
	inferenceRamClassFromEnv,
	resolveBackgroundInferenceBudget,
	setInferencePriorityGate,
} from "./inference-priority-gate";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Run `fn` on the gate and record start/end order + timing. */
function tracked(
	gate: InferencePriorityGate,
	log: string[],
	name: string,
	opts: {
		priority: "interactive" | "background";
		holdMs: number;
		waitMs?: number;
		signal?: AbortSignal;
	},
): Promise<void> {
	return gate.runExclusive(
		{
			priority: opts.priority,
			label: name,
			...(opts.waitMs !== undefined ? { waitMs: opts.waitMs } : {}),
			...(opts.signal ? { signal: opts.signal } : {}),
		},
		async () => {
			log.push(`start:${name}`);
			await sleep(opts.holdMs);
			log.push(`end:${name}`);
		},
	);
}

describe("InferencePriorityGate — lock priority", () => {
	it("an interactive turn completes within its envelope while a background job is mid-flight and more background jobs are queued", async () => {
		const gate = new InferencePriorityGate();
		const log: string[] = [];

		// Long background job takes the lane (the ~5-min autonomous job, scaled).
		const bg1 = tracked(gate, log, "bg1", {
			priority: "background",
			holdMs: 120,
		});
		await sleep(10); // bg1 is mid-flight

		// Another background firing queues behind it…
		const bg2 = tracked(gate, log, "bg2", {
			priority: "background",
			holdMs: 120,
			waitMs: 5_000,
		});
		await sleep(5);

		// …then an interactive chat turn arrives.
		const interactiveStartedAt = Date.now();
		const chat = tracked(gate, log, "chat", {
			priority: "interactive",
			holdMs: 20,
		});
		await chat;
		const interactiveTotalMs = Date.now() - interactiveStartedAt;

		await Promise.all([bg1, bg2]);

		// The interactive turn ran immediately after the in-flight holder —
		// AHEAD of the earlier-queued background job.
		expect(log).toEqual([
			"start:bg1",
			"end:bg1",
			"start:chat",
			"end:chat",
			"start:bg2",
			"end:bg2",
		]);
		// Envelope: holder remainder (~105ms) + own runtime (~20ms), NOT
		// remainder + bg2 (~120ms) + own runtime. Generous ceiling for CI jitter.
		expect(interactiveTotalMs).toBeLessThan(120 + 20 + 60);
	});

	it("keeps FIFO order within the interactive lane", async () => {
		const gate = new InferencePriorityGate();
		const log: string[] = [];
		const a = tracked(gate, log, "a", { priority: "interactive", holdMs: 30 });
		await sleep(5);
		const b = tracked(gate, log, "b", { priority: "interactive", holdMs: 10 });
		const c = tracked(gate, log, "c", { priority: "interactive", holdMs: 10 });
		await Promise.all([a, b, c]);
		expect(log).toEqual([
			"start:a",
			"end:a",
			"start:b",
			"end:b",
			"start:c",
			"end:c",
		]);
	});

	it("background runs immediately when the lane is idle", async () => {
		const gate = new InferencePriorityGate();
		const log: string[] = [];
		await tracked(gate, log, "bg", {
			priority: "background",
			holdMs: 5,
			waitMs: 1_000,
		});
		expect(log).toEqual(["start:bg", "end:bg"]);
	});

	it("bounded background wait: a background job that cannot start within waitMs fails typed and never runs", async () => {
		const gate = new InferencePriorityGate();
		const log: string[] = [];
		const holder = tracked(gate, log, "holder", {
			priority: "interactive",
			holdMs: 150,
		});
		await sleep(10);

		const bg = tracked(gate, log, "bg", {
			priority: "background",
			holdMs: 10,
			waitMs: 40,
		});
		await expect(bg).rejects.toBeInstanceOf(
			InferenceBackgroundWaitTimeoutError,
		);
		await expect(bg).rejects.toMatchObject({
			code: "INFERENCE_BACKGROUND_WAIT_TIMEOUT",
		});

		await holder;
		// The timed-out background job never touched the lane.
		expect(log).toEqual(["start:holder", "end:holder"]);
		expect(gate.snapshot()).toMatchObject({
			held: false,
			interactiveWaiting: 0,
			backgroundWaiting: 0,
		});
	});

	it("abort while waiting dequeues the request without running it", async () => {
		const gate = new InferencePriorityGate();
		const log: string[] = [];
		const holder = tracked(gate, log, "holder", {
			priority: "interactive",
			holdMs: 80,
		});
		await sleep(5);

		const controller = new AbortController();
		const waiting = tracked(gate, log, "aborted", {
			priority: "interactive",
			holdMs: 10,
			signal: controller.signal,
		});
		await sleep(5);
		controller.abort();
		await expect(waiting).rejects.toThrow(/aborted while waiting/);

		await holder;
		expect(log).toEqual(["start:holder", "end:holder"]);
		expect(gate.snapshot()).toMatchObject({
			held: false,
			interactiveWaiting: 0,
			backgroundWaiting: 0,
		});
	});

	it("releases the lane when the held function throws", async () => {
		const gate = new InferencePriorityGate();
		await expect(
			gate.runExclusive({ priority: "interactive" }, async () => {
				throw new Error("decode failed");
			}),
		).rejects.toThrow("decode failed");
		expect(gate.snapshot().held).toBe(false);
		// Lane still usable.
		await gate.runExclusive({ priority: "background" }, async () => {});
	});

	it("snapshot reports the holder and queue depths", async () => {
		const gate = new InferencePriorityGate();
		const log: string[] = [];
		const bg = tracked(gate, log, "bg", { priority: "background", holdMs: 60 });
		await sleep(5);
		const chat = tracked(gate, log, "chat", {
			priority: "interactive",
			holdMs: 5,
		});
		await sleep(5);
		const snap = gate.snapshot();
		expect(snap.held).toBe(true);
		expect(snap.holderPriority).toBe("background");
		expect(snap.interactiveWaiting).toBe(1);
		await Promise.all([bg, chat]);
	});
});

describe("process-wide singleton", () => {
	beforeEach(() => {
		setInferencePriorityGate(null);
	});

	it("returns one shared gate per process", () => {
		const gate = getInferencePriorityGate();
		expect(getInferencePriorityGate()).toBe(gate);
		const replacement = new InferencePriorityGate();
		setInferencePriorityGate(replacement);
		expect(getInferencePriorityGate()).toBe(replacement);
	});
});

describe("device-class background budget (#11760 seam)", () => {
	it("parses the ELIZA_INFERENCE_RAM_CLASS env contract", () => {
		expect(inferenceRamClassFromEnv({})).toBeNull();
		expect(
			inferenceRamClassFromEnv({ ELIZA_INFERENCE_RAM_CLASS: "constrained" }),
		).toBe("constrained");
		expect(
			inferenceRamClassFromEnv({ ELIZA_INFERENCE_RAM_CLASS: " Standard " }),
		).toBe("standard");
		expect(
			inferenceRamClassFromEnv({ ELIZA_INFERENCE_RAM_CLASS: "bogus" }),
		).toBeNull();
	});

	it("constrained budget is tighter than standard on every axis", () => {
		const constrained = resolveBackgroundInferenceBudget("constrained");
		const standard = resolveBackgroundInferenceBudget("standard");
		expect(constrained.maxTokens).toBeLessThan(standard.maxTokens);
		expect(constrained.maxPromptChars).toBeLessThan(standard.maxPromptChars);
		expect(constrained.lockWaitMs).toBeLessThan(standard.lockWaitMs);
	});

	it("clamps the observed poison job (11k-char prompt, maxTokens 8192) on a constrained device", () => {
		const budget = resolveBackgroundInferenceBudget("constrained");
		const prompt = "<start_of_turn>system\n".padEnd(11_169, "x");
		const result = applyBackgroundInferenceBudget(
			{ prompt, maxTokens: 8_192 },
			budget,
		);
		expect(result.prompt.length).toBeLessThanOrEqual(budget.maxPromptChars);
		expect(result.maxTokens).toBe(budget.maxTokens);
		expect(result.clamped).toHaveLength(2);
	});

	it("never clamps a request already inside the budget", () => {
		const budget = resolveBackgroundInferenceBudget("standard");
		const result = applyBackgroundInferenceBudget(
			{ prompt: "short prompt", maxTokens: 64 },
			budget,
		);
		expect(result.prompt).toBe("short prompt");
		expect(result.maxTokens).toBe(64);
		expect(result.clamped).toEqual([]);
	});

	it("defaults maxTokens to the budget cap when the caller left it unset", () => {
		const budget = resolveBackgroundInferenceBudget("constrained");
		const result = applyBackgroundInferenceBudget(
			{ prompt: "p", maxTokens: undefined },
			budget,
		);
		expect(result.maxTokens).toBe(budget.maxTokens);
		expect(result.clamped).toEqual([]);
	});

	it("middle-truncation preserves the prompt head and the generation suffix", () => {
		const head = "<start_of_turn>system\nYou are Eliza.";
		const tail = "latest context<end_of_turn>\n<start_of_turn>model\n";
		const prompt = head + "m".repeat(10_000) + tail;
		const clamped = clampBackgroundPrompt(prompt, 4_000);
		expect(clamped.length).toBeLessThanOrEqual(4_000);
		expect(clamped.startsWith("<start_of_turn>system\n")).toBe(true);
		expect(clamped.endsWith("<start_of_turn>model\n")).toBe(true);
		expect(clamped).toContain("middle truncated");
	});
});
