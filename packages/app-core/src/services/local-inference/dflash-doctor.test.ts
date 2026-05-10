import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./registry", () => ({
  listInstalledModels: vi.fn(async () => []),
}));

vi.mock("./dflash-server", async () => {
  const actual =
    await vi.importActual<typeof import("./dflash-server")>("./dflash-server");
  return {
    ...actual,
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
  it("emits one tokenizer-parity check per DFlash pair", async () => {
    const { runDflashDoctor } = await import("./dflash-doctor");
    const { MODEL_CATALOG } = await import("./catalog");
    const dflashTargets = MODEL_CATALOG.filter((m) => m.runtime?.dflash);
    expect(dflashTargets.length).toBeGreaterThan(0);
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
    // Surgically swap a DFlash drafterModelId to a non-existent id and
    // re-run. The doctor should fail the tokenizer-parity check for that
    // pair without affecting the others.
    const { MODEL_CATALOG } = await import("./catalog");
    const target = MODEL_CATALOG.find((m) => m.runtime?.dflash);
    if (!target?.runtime?.dflash) {
      throw new Error("test setup: no DFlash entries in the catalog");
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
});
