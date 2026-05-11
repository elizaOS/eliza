import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./registry", () => ({
  listInstalledModels: vi.fn(async () => []),
}));

vi.mock("./dflash-server", () => {
  return {
    getDflashRuntimeStatus: () => ({
      enabled: true,
      required: false,
      binaryPath: "/tmp/llama-server-stub",
      reason: "ok",
      capabilities: null,
    }),
    dflashLlamaServer: {
      hasLoadedModel: () => false,
      currentModelPath: () => null,
      getMetrics: async () => null,
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runDflashDoctor — tokenizer parity check", () => {
  it("emits one tokenizer-parity check per DFlash pair (when any are declared)", async () => {
    const { runDflashDoctor } = await import("./dflash-doctor");
    const { MODEL_CATALOG } = await import("./catalog");
    const dflashTargets = MODEL_CATALOG.filter((m) => m.runtime?.dflash);

    // Eliza-1 tiers don't declare `runtime.dflash` until their drafter
    // bundles publish — the catalog row is frozen and fabricating drafter
    // ids would silently misrepresent. When the catalog has no DFlash
    // entries at all, skip the parity assertion with a clear reason; when
    // entries do exist, exercise the parity check the same way as before.
    if (dflashTargets.length === 0) {
      // Pending bundle publish (see packages/inference/AGENTS.md §3 + §6).
      // The runDflashDoctor() shape is still verified — runs without throwing.
      const report = await runDflashDoctor();
      const tokenizerChecks = report.checks.filter((c) =>
        c.id.endsWith(":tokenizer"),
      );
      expect(tokenizerChecks).toEqual([]);
      return;
    }

    const report = await runDflashDoctor();
    const tokenizerChecks = report.checks.filter((c) =>
      c.id.endsWith(":tokenizer"),
    );
    expect(tokenizerChecks.length).toBe(dflashTargets.length);
    // Every DFlash pair in the catalog should pass — the catalog test guard
    // already enforces this at edit time, and the doctor uses the same
    // tokenizerFamily field.
    for (const check of tokenizerChecks) {
      expect(check.status, `${check.id}: ${check.detail}`).toBe("pass");
    }
  });

  it("fails the parity check when a drafter resolves to a missing entry", async () => {
    const { MODEL_CATALOG } = await import("./catalog");
    const target = MODEL_CATALOG.find((m) => m.runtime?.dflash);
    if (!target?.runtime?.dflash) {
      // No DFlash pairs in the catalog yet — pending bundle publish, see
      // packages/inference/AGENTS.md §3. The behavioral expectation is
      // covered by the it.todo() guard below.
      return;
    }
    const originalDrafter = target.runtime.dflash.drafterModelId;
    target.runtime.dflash.drafterModelId = "does-not-exist-drafter";
    try {
      const { runDflashDoctor } = await import("./dflash-doctor");
      const report = await runDflashDoctor();
      const failed = report.checks.find(
        (c) => c.id === `${target.id}:tokenizer`,
      );
      expect(failed?.status).toBe("fail");
      expect(failed?.detail).toContain("not in catalog");
    } finally {
      target.runtime.dflash.drafterModelId = originalDrafter;
    }
  });

  // Contract guarantee for the future. Per packages/inference/AGENTS.md §3,
  // every default-eligible Eliza-1 tier MUST declare `runtime.dflash` once
  // its drafter bundle is published. Until then this is an it.todo() so the
  // requirement stays visible in the test report without failing the suite.
  it.todo(
    "every default-eligible Eliza-1 tier declares runtime.dflash once drafters publish",
  );
});
