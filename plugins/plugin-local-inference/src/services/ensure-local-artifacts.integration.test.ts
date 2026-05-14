/**
 * Integration tests for `ensureLocalArtifacts`.
 *
 * The orchestrator's unit tests (`ensure-local-artifacts.test.ts`) inject a
 * tiny `vi.fn()`-shaped service. These integration tests stand up a more
 * realistic shape of `LocalInferenceService` — full method stubs with
 * `vi.fn` recording and configurable behavior — so the wiring inside the
 * service surface (`startDownload`, `getInstalled`, `getHardware`) is
 * exercised the way the real boot path would call it. The four-mode matrix
 * (cloud / remote / local + signedInCloud / local + !signedInCloud), the
 * already-installed short-circuit, and per-artifact failure isolation are
 * covered.
 *
 * Note on test lane: filename ends in `.integration.test.ts`. The default
 * vitest config picks this up via the `*.test.ts` glob, but if a future
 * lane excludes integration tests it should be run explicitly via the path
 * (see Part 3 of the parallel-sweep brief).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ensureLocalArtifacts } from "./ensure-local-artifacts";
import type { LocalInferenceService } from "./service";
import type { DownloadJob, HardwareProbe, InstalledModel } from "./types";

interface MockService {
	service: LocalInferenceService;
	startDownload: ReturnType<typeof vi.fn>;
	getHardware: ReturnType<typeof vi.fn>;
	getInstalled: ReturnType<typeof vi.fn>;
}

function makeJob(modelId: string): DownloadJob {
	return {
		jobId: `job-${modelId}`,
		modelId,
		state: "queued",
		received: 0,
		total: 1024,
		bytesPerSec: 0,
		etaMs: null,
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
}

function defaultHardware(): HardwareProbe {
	return {
		totalRamGb: 16,
		freeRamGb: 8,
		gpu: null,
		cpuCores: 8,
		platform: "darwin",
		arch: "arm64",
		appleSilicon: true,
		recommendedBucket: "mid",
		source: "os-fallback",
	};
}

interface MockServiceOverrides {
	installed?: InstalledModel[];
	hardware?: HardwareProbe;
	startDownloadImpl?: (modelId: string) => Promise<DownloadJob>;
}

function makeMockService(overrides: MockServiceOverrides = {}): MockService {
	const installed = overrides.installed ?? [];
	const hardware = overrides.hardware ?? defaultHardware();

	const startDownload = vi.fn(
		overrides.startDownloadImpl ??
			(async (modelId: string) => makeJob(modelId)),
	);
	const getHardware = vi.fn(async () => hardware);
	const getInstalled = vi.fn(async () => installed);

	const service = {
		startDownload,
		getHardware,
		getInstalled,
	} as unknown as LocalInferenceService;

	return { service, startDownload, getHardware, getInstalled };
}

function makeLogger() {
	return { info: vi.fn(), warn: vi.fn() };
}

describe("ensureLocalArtifacts integration", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("mode matrix", () => {
		it("cloud mode is a no-op (no service calls, artifacts: [], complete: true)", async () => {
			const mock = makeMockService();

			const result = await ensureLocalArtifacts({
				mode: "cloud",
				signedInCloud: true,
				service: mock.service,
				logger: makeLogger(),
			});

			expect(result).toEqual({ artifacts: [], complete: true });
			expect(mock.startDownload).not.toHaveBeenCalled();
			expect(mock.getHardware).not.toHaveBeenCalled();
			expect(mock.getInstalled).not.toHaveBeenCalled();
		});

		it("remote mode is a no-op (no service calls, artifacts: [], complete: true)", async () => {
			const mock = makeMockService();

			const result = await ensureLocalArtifacts({
				mode: "remote",
				signedInCloud: false,
				service: mock.service,
				logger: makeLogger(),
			});

			expect(result).toEqual({ artifacts: [], complete: true });
			expect(mock.startDownload).not.toHaveBeenCalled();
		});

		it("local mode + signedInCloud=true enqueues 3 artifacts (embedding/tts/stt) — not text", async () => {
			const mock = makeMockService();

			const result = await ensureLocalArtifacts({
				mode: "local",
				signedInCloud: true,
				service: mock.service,
				logger: makeLogger(),
			});

			const kinds = result.artifacts.map((a) => a.kind);
			expect(kinds.sort()).toEqual(["embedding", "stt", "tts"]);
			expect(kinds).not.toContain("text");
			expect(result.artifacts.every((a) => a.status === "started")).toBe(true);
			expect(result.complete).toBe(true);
			expect(mock.startDownload).toHaveBeenCalledTimes(3);
		});

		it("local mode + signedInCloud=false enqueues all 4 artifacts (incl. text)", async () => {
			const mock = makeMockService();

			const result = await ensureLocalArtifacts({
				mode: "local",
				signedInCloud: false,
				service: mock.service,
				logger: makeLogger(),
			});

			const kinds = result.artifacts.map((a) => a.kind);
			expect(kinds.sort()).toEqual(["embedding", "stt", "text", "tts"]);
			expect(result.artifacts.find((a) => a.kind === "text")?.status).toBe(
				"started",
			);
			expect(mock.startDownload).toHaveBeenCalledTimes(4);
			expect(result.complete).toBe(true);
		});

		it("local-only mode mirrors local for the artifact selection (4 with !signedInCloud)", async () => {
			const mock = makeMockService();

			const result = await ensureLocalArtifacts({
				mode: "local-only",
				signedInCloud: false,
				service: mock.service,
				logger: makeLogger(),
			});

			expect(mock.startDownload).toHaveBeenCalledTimes(4);
			expect(result.complete).toBe(true);
		});
	});

	describe("already-installed short-circuit", () => {
		it("records each kind as already-installed when the bundle is staged on disk", async () => {
			const installed: InstalledModel[] = [
				{
					id: "eliza-1-2b",
					displayName: "eliza-1-2b",
					path: "/tmp/eliza-1-2b.gguf",
					sizeBytes: 1024,
					installedAt: new Date().toISOString(),
					lastUsedAt: null,
					source: "eliza-download",
				},
			];
			// Pin the tier so the test does not depend on which tier the
			// recommender's hardware ladder lands on for `defaultHardware()`.
			const mock = makeMockService({ installed });

			const result = await ensureLocalArtifacts({
				mode: "local",
				tier: "2b",
				signedInCloud: false,
				service: mock.service,
				logger: makeLogger(),
			});

			expect(mock.startDownload).not.toHaveBeenCalled();
			expect(result.artifacts).toHaveLength(4); // includes text
			expect(
				result.artifacts.every((a) => a.status === "already-installed"),
			).toBe(true);
			expect(result.artifacts.every((a) => a.modelId === "eliza-1-2b")).toBe(
				true,
			);
			expect(result.complete).toBe(true);
		});
	});

	describe("failure isolation", () => {
		it("one startDownload rejection does not collapse the others; result is partial", async () => {
			// First call rejects; subsequent calls succeed. The orchestrator wraps
			// each artifact in its own settled slot, so the other downloads still
			// count as `started` and the aggregate is `complete: false`.
			const mock = makeMockService({
				startDownloadImpl: async (modelId: string) => {
					if (mock.startDownload.mock.calls.length === 1) {
						throw new Error("simulated download backend failure");
					}
					return makeJob(modelId);
				},
			});

			const result = await ensureLocalArtifacts({
				mode: "local",
				signedInCloud: false,
				service: mock.service,
				logger: makeLogger(),
			});

			const statuses = result.artifacts.map((a) => a.status);
			expect(statuses).toContain("failed");
			expect(statuses).toContain("started");
			expect(statuses.filter((s) => s === "started").length).toBe(3);
			expect(statuses.filter((s) => s === "failed").length).toBe(1);
			expect(result.complete).toBe(false);

			const failed = result.artifacts.find((a) => a.status === "failed");
			expect(failed?.reason).toContain("simulated download backend failure");
		});

		it("a getInstalled() failure does not stop the downloads — orchestrator still fires every kind", async () => {
			const mock = makeMockService();
			// Override the auto-success mock with one that throws.
			mock.getInstalled.mockImplementationOnce(async () => {
				throw new Error("disk read failed");
			});

			const result = await ensureLocalArtifacts({
				mode: "local",
				signedInCloud: true,
				service: mock.service,
				logger: makeLogger(),
			});

			// Three downloads (embedding/tts/stt) all fired despite the install probe failure.
			expect(mock.startDownload).toHaveBeenCalledTimes(3);
			expect(result.complete).toBe(true);
			expect(result.artifacts.every((a) => a.status === "started")).toBe(true);
		});
	});
});
