import { describe, expect, it } from "vitest";
import {
  estimateQuantizedKvBytesPerToken,
  KV_PAGE_TOKENS,
  KV_SPILL_MIN_CONTEXT,
  KV_SPILL_VOICE_LATENCY_BUDGET_MS,
  type KvGeometry,
  KvSpillUnsupportedError,
  planKvSpill,
  residentKvBudgetFromRamBudget,
  restoreClassForHardware,
} from "./kv-spill";
import type { RamBudget } from "./ram-budget";

const MIB = 1024 * 1024;

function geometry(overrides: Partial<KvGeometry> = {}): KvGeometry {
  return { bytesPerToken: 2_000, voiceEnabled: false, ...overrides };
}

describe("planKvSpill", () => {
  it("returns resident when the whole compressed KV fits the budget", () => {
    // 32k tokens * 2000 B/token = 64 MiB; budget 128 MiB.
    const plan = planKvSpill({
      requestedContext: 32_768,
      geometry: geometry(),
      residentKvBudgetBytes: 128 * MIB,
      restoreClass: "cpu-pcie",
      cpuSpillAvailable: true,
    });
    expect(plan.mode).toBe("resident");
    if (plan.mode !== "resident") throw new Error("unreachable");
    expect(plan.residentBytes).toBe(plan.totalKvBytes);
  });

  it("spills the cold pages on a long context that overruns the resident budget", () => {
    // 256k tokens * 2000 B/token = 512 MiB; budget 64 MiB → most pages spill.
    const plan = planKvSpill({
      requestedContext: 262_144,
      geometry: geometry(),
      residentKvBudgetBytes: 64 * MIB,
      restoreClass: "cpu-pcie",
      cpuSpillAvailable: true,
    });
    expect(plan.mode).toBe("spill");
    if (plan.mode !== "spill") throw new Error("unreachable");
    expect(plan.tier).toBe("cpu");
    expect(plan.spillPages).toBeGreaterThan(0);
    expect(plan.residentPages).toBeGreaterThanOrEqual(1);
    expect(plan.residentBytes + plan.spillBytes).toBe(plan.totalKvBytes);
    // 256-token page * 2000 B = 512_000 B; PCIe budget 12_000_000 B/ms →
    // ~0.043 ms per page restore, comfortably under any budget.
    expect(plan.worstCaseRestoreMs).toBeLessThan(plan.latencyBudgetMs);
    expect(plan.latencyBudgetMs).toBe(1_500);
  });

  it("uses the tighter voice budget when the bundle has voice enabled", () => {
    const plan = planKvSpill({
      requestedContext: 262_144,
      geometry: geometry({ voiceEnabled: true }),
      residentKvBudgetBytes: 64 * MIB,
      restoreClass: "cpu-pcie",
      cpuSpillAvailable: true,
    });
    expect(plan.mode).toBe("spill");
    if (plan.mode !== "spill") throw new Error("unreachable");
    expect(plan.latencyBudgetMs).toBe(KV_SPILL_VOICE_LATENCY_BUDGET_MS);
  });

  it("hard-fails with a structured error when cold-page restore misses the voice budget", () => {
    // Big per-token KV + slow SATA disk → a single page restore blows the
    // 200ms voice budget. Page = 256 * 200_000 B = 51.2 MB; SATA budget
    // 250_000 B/ms → ~205 ms > 200 ms.
    let thrown: unknown;
    try {
      planKvSpill({
        requestedContext: 262_144,
        geometry: geometry({ bytesPerToken: 200_000, voiceEnabled: true }),
        residentKvBudgetBytes: 64 * MIB,
        restoreClass: "disk-sata",
        cpuSpillAvailable: false,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(KvSpillUnsupportedError);
    const e = thrown as KvSpillUnsupportedError;
    expect(e.code).toBe("kv-spill-unsupported");
    expect(e.details.voiceEnabled).toBe(true);
    expect(e.details.restoreClass).toBe("disk-sata");
    expect(e.details.worstCaseRestoreMs).toBeGreaterThan(
      e.details.latencyBudgetMs,
    );
    expect(e.message).toContain("voice latency budget");
  });

  it("degrades the spill tier to disk and downgrades a cpu restore class when CPU spill is unavailable", () => {
    const plan = planKvSpill({
      requestedContext: 262_144,
      geometry: geometry(),
      residentKvBudgetBytes: 64 * MIB,
      restoreClass: "cpu-pcie",
      cpuSpillAvailable: false,
    });
    expect(plan.mode).toBe("spill");
    if (plan.mode !== "spill") throw new Error("unreachable");
    expect(plan.tier).toBe("disk");
    // worstCaseRestoreMs reflects the NVMe class, not the cpu-pcie one.
    expect(plan.worstCaseRestoreMs).toBeGreaterThan(
      // page (512_000 B) / cpu-pcie (12e6) ≈ 0.043 ms
      512_000 / 12_000_000,
    );
  });

  it("page-aligns the resident/spill split", () => {
    const plan = planKvSpill({
      requestedContext: 200_000,
      geometry: geometry(),
      residentKvBudgetBytes: 30 * MIB,
      restoreClass: "cpu-apple",
      cpuSpillAvailable: true,
    });
    expect(plan.mode).toBe("spill");
    if (plan.mode !== "spill") throw new Error("unreachable");
    const pageBytes = 2_000 * KV_PAGE_TOKENS;
    expect(plan.residentBytes % pageBytes).toBe(0);
    expect(plan.spillBytes % pageBytes).toBe(0);
    const totalPages = Math.ceil(200_000 / KV_PAGE_TOKENS);
    expect(plan.residentPages + plan.spillPages).toBe(totalPages);
  });

  it("treats a short context that overruns the resident budget as unsupported (wrong tier for device)", () => {
    // 64k - 1 tokens, but a per-token KV so large the cache won't fit and
    // we're below KV_SPILL_MIN_CONTEXT → structured error, no half-load.
    let thrown: unknown;
    try {
      planKvSpill({
        requestedContext: KV_SPILL_MIN_CONTEXT - 1,
        geometry: geometry({ bytesPerToken: 50_000 }),
        residentKvBudgetBytes: 16 * MIB,
        restoreClass: "cpu-apple",
        cpuSpillAvailable: true,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(KvSpillUnsupportedError);
    expect((thrown as KvSpillUnsupportedError).details.requestedContext).toBe(
      KV_SPILL_MIN_CONTEXT - 1,
    );
  });

  it("rejects degenerate inputs loudly", () => {
    expect(() =>
      planKvSpill({
        requestedContext: 0,
        geometry: geometry(),
        residentKvBudgetBytes: MIB,
        restoreClass: "cpu-apple",
        cpuSpillAvailable: true,
      }),
    ).toThrow(/positive context/);
    expect(() =>
      planKvSpill({
        requestedContext: 100_000,
        geometry: geometry(),
        residentKvBudgetBytes: 0,
        restoreClass: "cpu-apple",
        cpuSpillAvailable: true,
      }),
    ).toThrow(/residentKvBudgetBytes must be positive/);
  });
});

describe("residentKvBudgetFromRamBudget", () => {
  it("reserves the documented KV fraction of the recommended budget", () => {
    const budget: RamBudget = {
      minMb: 7000,
      recommendedMb: 9600,
      source: "manifest",
    };
    // 9600 MiB * 0.25 = 2400 MiB
    expect(residentKvBudgetFromRamBudget(budget)).toBe(2400 * MIB);
  });
});

describe("estimateQuantizedKvBytesPerToken", () => {
  it("returns the per-tier figure for known param strings", () => {
    expect(estimateQuantizedKvBytesPerToken("0.8B")).toBeLessThan(
      estimateQuantizedKvBytesPerToken("9B"),
    );
    expect(estimateQuantizedKvBytesPerToken("2B")).toBeGreaterThan(
      estimateQuantizedKvBytesPerToken("0.8B"),
    );
    expect(estimateQuantizedKvBytesPerToken("4B")).toBeGreaterThan(
      estimateQuantizedKvBytesPerToken("2B"),
    );
    expect(estimateQuantizedKvBytesPerToken("27B")).toBeGreaterThan(
      estimateQuantizedKvBytesPerToken("9B"),
    );
  });

  it("fails closed (largest tier) for unknown param strings", () => {
    expect(estimateQuantizedKvBytesPerToken("999B")).toBe(
      estimateQuantizedKvBytesPerToken("27B"),
    );
  });
});

describe("restoreClassForHardware", () => {
  it("maps Apple Silicon, discrete GPU, and CPU-only to the right classes", () => {
    expect(
      restoreClassForHardware({ appleSilicon: true, hasDiscreteGpu: false }),
    ).toBe("cpu-apple");
    expect(
      restoreClassForHardware({ appleSilicon: false, hasDiscreteGpu: true }),
    ).toBe("cpu-pcie");
    expect(
      restoreClassForHardware({ appleSilicon: false, hasDiscreteGpu: false }),
    ).toBe("disk-nvme");
  });
});
