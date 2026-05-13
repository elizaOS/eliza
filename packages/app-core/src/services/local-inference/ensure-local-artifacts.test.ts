/**
 * Tests for the local-artifact orchestrator. Every test injects a fake
 * `LocalInferenceService` so the real downloader / hardware probe stay out
 * of the picture — the orchestrator's contract is "trigger parallel
 * downloads via the service facade", and the test verifies exactly that.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ensureLocalArtifacts } from "./ensure-local-artifacts";
import type { LocalInferenceService } from "./service";
import type { DownloadJob, HardwareProbe, InstalledModel } from "./types";

interface FakeServiceState {
  hardware: HardwareProbe;
  installed: InstalledModel[];
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

/**
 * Default probe is a modest Apple Silicon laptop — the recommender's ladder
 * lands on an Eliza-1 tier for this shape, which keeps the assertions
 * concrete (per-tier assertions pin the tier explicitly via the `tier`
 * arg so they decouple from `recommendation.ts` changes).
 */
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

function makeService(
  overrides: Partial<FakeServiceState> = {},
): { service: LocalInferenceService; state: FakeServiceState } {
  const startDownload = vi.fn(async (modelId: string) => makeJob(modelId));
  const installed = overrides.installed ?? [];
  const hardware = overrides.hardware ?? defaultHardware();
  const getHardware = vi.fn(async () => hardware);
  const getInstalled = vi.fn(async () => installed);

  const state: FakeServiceState = {
    hardware,
    installed,
    startDownload,
    getHardware,
    getInstalled,
  };

  const service = {
    startDownload,
    getHardware,
    getInstalled,
    // Other methods on the real facade are never touched by the
    // orchestrator; the type-cast below is the seam.
  } as unknown as LocalInferenceService;

  return { service, state };
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe("ensureLocalArtifacts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is a no-op in cloud mode (no downloads, complete=true)", async () => {
    const { service, state } = makeService();
    const logger = makeLogger();

    const result = await ensureLocalArtifacts({
      mode: "cloud",
      signedInCloud: true,
      service,
      logger,
    });

    expect(result.complete).toBe(true);
    expect(result.artifacts).toEqual([]);
    expect(state.startDownload).not.toHaveBeenCalled();
    expect(state.getHardware).not.toHaveBeenCalled();
    expect(state.getInstalled).not.toHaveBeenCalled();
  });

  it("is a no-op in remote mode", async () => {
    const { service, state } = makeService();

    const result = await ensureLocalArtifacts({
      mode: "remote",
      signedInCloud: false,
      service,
      logger: makeLogger(),
    });

    expect(result.complete).toBe(true);
    expect(result.artifacts).toEqual([]);
    expect(state.startDownload).not.toHaveBeenCalled();
  });

  it("local + signedInCloud=true triggers embedding/tts/stt but skips text", async () => {
    const { service, state } = makeService();
    const logger = makeLogger();

    const result = await ensureLocalArtifacts({
      mode: "local",
      signedInCloud: true,
      service,
      logger,
    });

    const kinds = result.artifacts.map((a) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(["embedding", "tts", "stt"]));
    expect(kinds).not.toContain("text");
    expect(result.artifacts.every((a) => a.status === "started")).toBe(true);
    expect(result.complete).toBe(true);

    // startDownload should fire once per artifact kind. The downloader
    // is internally idempotent on the modelId, so even when several
    // calls share the same id (the bundle today) all three slots
    // produce a `started` outcome.
    expect(state.startDownload).toHaveBeenCalledTimes(3);
  });

  it("local + signedInCloud=false triggers all four artifacts including text", async () => {
    const { service, state } = makeService();

    const result = await ensureLocalArtifacts({
      mode: "local",
      signedInCloud: false,
      service,
      logger: makeLogger(),
    });

    const kinds = result.artifacts.map((a) => a.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(["embedding", "tts", "stt", "text"]),
    );
    expect(result.artifacts.find((a) => a.kind === "text")?.status).toBe(
      "started",
    );
    expect(state.startDownload).toHaveBeenCalledTimes(4);
    expect(result.complete).toBe(true);
  });

  it("local-only mode behaves identically to local for artifact selection", async () => {
    const { service, state } = makeService();

    await ensureLocalArtifacts({
      mode: "local-only",
      signedInCloud: false,
      service,
      logger: makeLogger(),
    });

    expect(state.startDownload).toHaveBeenCalledTimes(4);
  });

  it("respects an explicit tier override (skips hardware probe)", async () => {
    const { service, state } = makeService();

    const result = await ensureLocalArtifacts({
      mode: "local",
      tier: "9b",
      signedInCloud: false,
      service,
      logger: makeLogger(),
    });

    expect(state.getHardware).not.toHaveBeenCalled();
    expect(
      result.artifacts.every((a) => a.modelId === "eliza-1-9b"),
    ).toBe(true);
  });

  it("runs the four downloads in parallel via Promise.allSettled", async () => {
    const order: string[] = [];
    // Build the resolver alongside the Promise so TypeScript can pin the
    // resolver as a non-null callable — the executor-pattern leaves the
    // resolver typed as `(() => void) | null` after narrowing.
    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });

    const startDownload = vi.fn(async (modelId: string) => {
      order.push(`enter:${modelId}`);
      await gate;
      order.push(`exit:${modelId}`);
      return makeJob(modelId);
    });
    const getHardware = vi.fn(async () => defaultHardware());
    const getInstalled = vi.fn(async () => []);
    const service = {
      startDownload,
      getHardware,
      getInstalled,
    } as unknown as LocalInferenceService;

    const promise = ensureLocalArtifacts({
      mode: "local",
      signedInCloud: false,
      service,
      logger: makeLogger(),
    });

    // Wait one microtask cycle so every artifact has a chance to enter.
    await new Promise((r) => setTimeout(r, 0));

    // Four artifacts must all have entered before any can exit — that's
    // what "parallel" buys us. If the orchestrator awaited them
    // sequentially, only one would have entered by now.
    const enters = order.filter((e) => e.startsWith("enter:")).length;
    expect(enters).toBe(4);

    resolveGate();
    await promise;
    expect(order.filter((e) => e.startsWith("exit:")).length).toBe(4);
  });

  it("records already-installed when the chosen bundle is present", async () => {
    // Pin the tier so the test is decoupled from the recommender's
    // platform-class ladder (which on the test's modest Apple-Silicon
    // probe may land on a different tier). The orchestrator's contract is
    // "skip when installed"; the tier picker is a separate concern
    // already covered by `recommendation.test.ts`.
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
    const { service, state } = makeService({ installed });

    const result = await ensureLocalArtifacts({
      mode: "local",
      tier: "2b",
      signedInCloud: false,
      service,
      logger: makeLogger(),
    });

    expect(state.startDownload).not.toHaveBeenCalled();
    expect(
      result.artifacts.every((a) => a.status === "already-installed"),
    ).toBe(true);
    expect(result.complete).toBe(true);
  });

  it("does not fail the orchestrator on individual artifact failures", async () => {
    const startDownload = vi.fn(async (modelId: string) => {
      // First call rejects; subsequent calls succeed. The orchestrator
      // must wrap each artifact independently so one failure doesn't
      // collapse the others.
      if (startDownload.mock.calls.length === 1) {
        throw new Error("simulated network failure");
      }
      return makeJob(modelId);
    });
    const service = {
      startDownload,
      getHardware: vi.fn(async () => defaultHardware()),
      getInstalled: vi.fn(async () => []),
    } as unknown as LocalInferenceService;
    const logger = makeLogger();

    const result = await ensureLocalArtifacts({
      mode: "local",
      signedInCloud: false,
      service,
      logger,
    });

    const statuses = result.artifacts.map((a) => a.status);
    expect(statuses).toContain("failed");
    expect(statuses).toContain("started");
    expect(result.complete).toBe(false);
    const failed = result.artifacts.find((a) => a.status === "failed");
    expect(failed?.reason).toContain("simulated network failure");
  });

  it("returns a skipped result when the recommender finds no fitting tier", async () => {
    // A device with 0 GB of RAM defeats every tier's floor; the
    // recommender returns null and the orchestrator records skipped
    // outcomes per kind.
    const hardware: HardwareProbe = {
      ...defaultHardware(),
      totalRamGb: 0,
      freeRamGb: 0,
    };
    const { service, state } = makeService({ hardware });

    const result = await ensureLocalArtifacts({
      mode: "local",
      signedInCloud: false,
      service,
      logger: makeLogger(),
    });

    expect(state.startDownload).not.toHaveBeenCalled();
    expect(result.complete).toBe(false);
    expect(
      result.artifacts.every((a) => a.status === "skipped"),
    ).toBe(true);
    expect(result.artifacts.length).toBe(4); // includes text since signedInCloud=false
  });

  it("tolerates a getInstalled() failure and still triggers the downloads", async () => {
    const startDownload = vi.fn(async (modelId: string) => makeJob(modelId));
    const service = {
      startDownload,
      getHardware: vi.fn(async () => defaultHardware()),
      getInstalled: vi.fn(async () => {
        throw new Error("disk read failed");
      }),
    } as unknown as LocalInferenceService;
    const logger = makeLogger();

    const result = await ensureLocalArtifacts({
      mode: "local",
      signedInCloud: true,
      service,
      logger,
    });

    // Three downloads (embedding/tts/stt) — text skipped due to
    // signedInCloud — and every one fired despite the install probe
    // failure.
    expect(startDownload).toHaveBeenCalledTimes(3);
    expect(result.complete).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });
});
