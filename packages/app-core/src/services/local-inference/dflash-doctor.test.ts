import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./registry", () => ({
  listInstalledModels: vi.fn(async () => []),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runDflashDoctor — tokenizer parity check", () => {
  it("emits one tokenizer-parity check per DFlash pair (when any are declared)", async () => {
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
    const { MODEL_CATALOG } = await import("./catalog");
    const target = MODEL_CATALOG.find((m) => m.runtime?.dflash);
    if (!target?.runtime?.dflash) {
      throw new Error("Expected at least one DFlash catalog entry");
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

  it("every default-eligible Eliza-1 tier declares runtime.dflash", async () => {
    const { ELIZA_1_RELEASE_TIER_IDS, MODEL_CATALOG, isDefaultEligibleId } =
      await import("./catalog");

    for (const id of ELIZA_1_RELEASE_TIER_IDS) {
      const model = MODEL_CATALOG.find((m) => m.id === id);
      expect(model, `${id} missing from catalog`).toBeDefined();
      expect(isDefaultEligibleId(id), `${id} should be default-eligible`).toBe(
        true,
      );
      expect(
        model?.runtime?.dflash,
        `${id} missing runtime.dflash`,
      ).toBeDefined();

      const drafterId = model?.runtime?.dflash?.drafterModelId;
      expect(drafterId).toBe(`${id}-drafter`);

      const drafter = MODEL_CATALOG.find((m) => m.id === drafterId);
      expect(drafter, `${drafterId} missing from catalog`).toBeDefined();
      expect(drafter?.runtimeRole).toBe("dflash-drafter");
      expect(drafter?.companionForModelId).toBe(id);
      expect(drafter?.tokenizerFamily).toBe(model?.tokenizerFamily);
    }
  });
});
