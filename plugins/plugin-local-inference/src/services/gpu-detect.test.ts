/**
 * detectGpu() probe semantics — issue #11339.
 *
 * The boot-time probe result is cached for the process lifetime, so a wrong
 * first answer permanently demotes embedding selection. These tests pin the
 * retry contract:
 *
 *   - a timeout-killed first call (RTD3 cold wake in flight) retries ONCE
 *     with the extended deadline;
 *   - a fast nonzero exit (driver in runtime-PM `error` state — observed on
 *     an RTX 5080 Laptop after a failed GSP suspend, `nvidia-smi` exit 6) is
 *     a real "no usable GPU" answer and is NOT retried;
 *   - a missing binary (ENOENT) is NOT retried.
 */
import type { SpawnSyncReturns } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
	__resetGpuDetectionCacheForTests,
	__setGpuDetectionSpawnSyncForTests,
	detectGpu,
} from "./gpu-detect.js";

interface RecordedCall {
	command: string;
	args: string[];
	timeout: number | undefined;
}

function result(
	overrides: Partial<SpawnSyncReturns<string>>,
): SpawnSyncReturns<string> {
	return {
		pid: 4242,
		output: [],
		stdout: "",
		stderr: "",
		status: 0,
		signal: null,
		...overrides,
	};
}

function timedOut(): SpawnSyncReturns<string> {
	const error = new Error(
		"spawnSync nvidia-smi ETIMEDOUT",
	) as NodeJS.ErrnoException;
	error.code = "ETIMEDOUT";
	return result({ status: null, signal: "SIGTERM", error });
}

function enoent(): SpawnSyncReturns<string> {
	const error = new Error("spawn nvidia-smi ENOENT") as NodeJS.ErrnoException;
	error.code = "ENOENT";
	return result({ status: null, error });
}

/** The exact shape this host produced with the driver in PM `error` state. */
function unknownErrorExit6(): SpawnSyncReturns<string> {
	return result({
		status: 6,
		stderr:
			"Unable to determine the device handle for GPU0: 0000:02:00.0: Unknown Error\nNo devices were found\n",
	});
}

function gpuCsv(): SpawnSyncReturns<string> {
	return result({ stdout: "NVIDIA GeForce RTX 5080 Laptop GPU, 16303\n" });
}

/**
 * Install a scripted nvidia-smi runner: call N returns `script[N]`
 * (the last entry repeats). Returns the recorded call list.
 */
function scriptRunner(script: SpawnSyncReturns<string>[]): RecordedCall[] {
	const calls: RecordedCall[] = [];
	__setGpuDetectionSpawnSyncForTests((command, args, options) => {
		calls.push({
			command,
			args,
			timeout: options && "timeout" in options ? options.timeout : undefined,
		});
		return script[Math.min(calls.length - 1, script.length - 1)];
	});
	return calls;
}

afterEach(() => {
	__resetGpuDetectionCacheForTests();
});

describe("detectGpu probe retry (issue #11339)", () => {
	it("returns the GPU on a clean first call without retrying", () => {
		const calls = scriptRunner([gpuCsv()]);
		const detection = detectGpu({ force: true });
		expect(calls).toHaveLength(1);
		expect(calls[0].command).toBe("nvidia-smi");
		expect(calls[0].timeout).toBe(3_000);
		expect(detection.nvidiaPresent).toBe(true);
		expect(detection.gpu?.name).toBe("NVIDIA GeForce RTX 5080 Laptop GPU");
		expect(detection.gpu?.totalMemoryMiB).toBe(16303);
	});

	it("retries once with the extended deadline after a timeout kill (RTD3 cold wake)", () => {
		const calls = scriptRunner([timedOut(), gpuCsv()]);
		const detection = detectGpu({ force: true });
		expect(calls).toHaveLength(2);
		expect(calls[0].timeout).toBe(3_000);
		expect(calls[1].timeout).toBe(15_000);
		expect(detection.nvidiaPresent).toBe(true);
		expect(detection.gpu?.name).toBe("NVIDIA GeForce RTX 5080 Laptop GPU");
	});

	it("gives up after the single retry also times out — never a third call", () => {
		const calls = scriptRunner([timedOut(), timedOut()]);
		const detection = detectGpu({ force: true });
		expect(calls).toHaveLength(2);
		expect(detection).toEqual({
			nvidiaPresent: false,
			gpu: null,
			profile: null,
		});
	});

	it("does NOT retry a fast nonzero exit (driver in runtime-PM error state)", () => {
		const calls = scriptRunner([unknownErrorExit6()]);
		const detection = detectGpu({ force: true });
		expect(calls).toHaveLength(1);
		expect(detection).toEqual({
			nvidiaPresent: false,
			gpu: null,
			profile: null,
		});
	});

	it("does NOT retry a missing nvidia-smi binary (ENOENT)", () => {
		const calls = scriptRunner([enoent()]);
		const detection = detectGpu({ force: true });
		expect(calls).toHaveLength(1);
		expect(detection).toEqual({
			nvidiaPresent: false,
			gpu: null,
			profile: null,
		});
	});

	it("caches the post-retry success so later calls skip the probe", () => {
		const calls = scriptRunner([timedOut(), gpuCsv()]);
		detectGpu({ force: true });
		const second = detectGpu();
		expect(calls).toHaveLength(2);
		expect(second.nvidiaPresent).toBe(true);
	});

	it("force re-probes through the cache", () => {
		const calls = scriptRunner([gpuCsv()]);
		detectGpu({ force: true });
		detectGpu({ force: true });
		expect(calls).toHaveLength(2);
	});
});
