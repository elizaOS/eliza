/**
 * Exhaustive + fuzz unit tests for the onboarding state machine in
 * `../flow.ts`. Pure functions only — no DOM, no React, no network.
 *
 * `canRunLocal` is the only impure dependency flow.ts has; it is mocked so
 * sidebar/nav-metas behaviour is deterministic across host environments.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const canRunLocalMock = vi.fn<() => boolean>(() => false);

vi.mock("../../platform/init", () => ({
  canRunLocal: () => canRunLocalMock(),
}));

import {
  canRevertOnboardingTo,
  getFlaminaTopicForOnboardingStep,
  getOnboardingNavMetas,
  getOnboardingStepIndex,
  getStepOrder,
  resolveOnboardingNextStep,
  resolveOnboardingPreviousStep,
  shouldSkipConnectionStepsForCloudProvisionedContainer,
  shouldSkipFeaturesStep,
  shouldUseCloudOnboardingFastTrack,
} from "../flow";
import {
  inferOnboardingResumeStep,
  hasPartialOnboardingConnectionConfig,
} from "../../state/onboarding-resume";
import { restartAgentAfterOnboarding } from "../../state/onboarding-restart";
import type { OnboardingStep } from "../../state/types";
import { ONBOARDING_STEPS } from "../../state/types";

const STEP_IDS = ONBOARDING_STEPS.map((s) => s.id);
const EXPECTED_ORDER: OnboardingStep[] = ["deployment", "providers", "features"];

const INVALID_STEPS = [
  "",
  "DEPLOYMENT",
  "deploymentt",
  "review",
  "summary",
  "unknown",
  "null",
  "undefined",
  "123",
  " ",
  "deployment ",
  "providersfeatures",
] as const;

/**
 * Deterministic mulberry32 PRNG. Fuzz failures must be reproducible — a fixed
 * seed plus a pure generator means a failing iteration index identifies the
 * exact walk that broke.
 */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)] as T;
}

beforeEach(() => {
  canRunLocalMock.mockReset();
  canRunLocalMock.mockReturnValue(false);
});

describe("getStepOrder", () => {
  it("matches the documented 3-step ordering", () => {
    expect(getStepOrder()).toEqual(EXPECTED_ORDER);
  });

  it("is a fresh array (caller mutations cannot poison subsequent reads)", () => {
    const a = getStepOrder();
    a.pop();
    expect(getStepOrder()).toEqual(EXPECTED_ORDER);
  });
});

describe("getOnboardingStepIndex", () => {
  it.each(EXPECTED_ORDER.map((id, idx) => [id, idx] as const))(
    "%s -> index %i",
    (id, idx) => {
      expect(getOnboardingStepIndex(id)).toBe(idx);
    },
  );

  it.each(INVALID_STEPS)("returns -1 for invalid id %j", (bad) => {
    expect(getOnboardingStepIndex(bad as unknown as OnboardingStep)).toBe(-1);
  });
});

describe("resolveOnboardingNextStep (exhaustive linear forward)", () => {
  it("deployment -> providers", () => {
    expect(resolveOnboardingNextStep("deployment")).toBe("providers");
  });

  it("providers -> features", () => {
    expect(resolveOnboardingNextStep("providers")).toBe("features");
  });

  it("features -> null (terminal)", () => {
    expect(resolveOnboardingNextStep("features")).toBeNull();
  });

  it.each(INVALID_STEPS)("invalid id %j -> null", (bad) => {
    expect(
      resolveOnboardingNextStep(bad as unknown as OnboardingStep),
    ).toBeNull();
  });

  it("for every valid step, result is either null or a configured step id", () => {
    for (const step of EXPECTED_ORDER) {
      const next = resolveOnboardingNextStep(step);
      if (next !== null) {
        expect(STEP_IDS).toContain(next);
      }
    }
  });
});

describe("resolveOnboardingPreviousStep (exhaustive linear backward)", () => {
  it("deployment -> null (first step has no prev)", () => {
    expect(resolveOnboardingPreviousStep("deployment")).toBeNull();
  });

  it("providers -> deployment", () => {
    expect(resolveOnboardingPreviousStep("providers")).toBe("deployment");
  });

  it("features -> providers", () => {
    expect(resolveOnboardingPreviousStep("features")).toBe("providers");
  });

  it.each(INVALID_STEPS)("invalid id %j -> null", (bad) => {
    expect(
      resolveOnboardingPreviousStep(bad as unknown as OnboardingStep),
    ).toBeNull();
  });

  it("for every valid step, result is either null or a configured step id", () => {
    for (const step of EXPECTED_ORDER) {
      const prev = resolveOnboardingPreviousStep(step);
      if (prev !== null) {
        expect(STEP_IDS).toContain(prev);
      }
    }
  });
});

describe("next/prev round trip", () => {
  it("next then prev returns the original step (except at terminals)", () => {
    for (const step of EXPECTED_ORDER) {
      const next = resolveOnboardingNextStep(step);
      if (next === null) continue;
      expect(resolveOnboardingPreviousStep(next)).toBe(step);
    }
  });

  it("prev then next returns the original step (except at deployment)", () => {
    for (const step of EXPECTED_ORDER) {
      const prev = resolveOnboardingPreviousStep(step);
      if (prev === null) continue;
      expect(resolveOnboardingNextStep(prev)).toBe(step);
    }
  });
});

describe("canRevertOnboardingTo (sidebar jump rules)", () => {
  it("strictly earlier targets are allowed (full cross product)", () => {
    for (let curIdx = 0; curIdx < EXPECTED_ORDER.length; curIdx += 1) {
      for (let tgtIdx = 0; tgtIdx < EXPECTED_ORDER.length; tgtIdx += 1) {
        const current = EXPECTED_ORDER[curIdx]!;
        const target = EXPECTED_ORDER[tgtIdx]!;
        const allowed = canRevertOnboardingTo({ current, target });
        expect(allowed).toBe(tgtIdx < curIdx);
      }
    }
  });

  it("identical current and target is rejected (no self-jump)", () => {
    for (const step of EXPECTED_ORDER) {
      expect(canRevertOnboardingTo({ current: step, target: step })).toBe(
        false,
      );
    }
  });

  it("forward jumps are rejected", () => {
    expect(
      canRevertOnboardingTo({ current: "deployment", target: "providers" }),
    ).toBe(false);
    expect(
      canRevertOnboardingTo({ current: "deployment", target: "features" }),
    ).toBe(false);
    expect(
      canRevertOnboardingTo({ current: "providers", target: "features" }),
    ).toBe(false);
  });

  it("invalid current is rejected", () => {
    for (const bad of INVALID_STEPS) {
      expect(
        canRevertOnboardingTo({
          current: bad as unknown as OnboardingStep,
          target: "deployment",
        }),
      ).toBe(false);
    }
  });

  it("invalid target is rejected", () => {
    for (const bad of INVALID_STEPS) {
      expect(
        canRevertOnboardingTo({
          current: "features",
          target: bad as unknown as OnboardingStep,
        }),
      ).toBe(false);
    }
  });
});

describe("getOnboardingNavMetas", () => {
  it("when cloudOnly=true the deployment row is hidden regardless of platform", () => {
    canRunLocalMock.mockReturnValue(false);
    const metas = getOnboardingNavMetas("providers", true);
    expect(metas.map((m) => m.id)).toEqual(["providers", "features"]);
  });

  it("when canRunLocal() is true (desktop/dev) the deployment row is hidden", () => {
    canRunLocalMock.mockReturnValue(true);
    const metas = getOnboardingNavMetas("providers", false);
    expect(metas.map((m) => m.id)).toEqual(["providers", "features"]);
  });

  it("when cloudOnly=false and canRunLocal()=false (mobile/web) deployment is shown", () => {
    canRunLocalMock.mockReturnValue(false);
    const metas = getOnboardingNavMetas("deployment", false);
    expect(metas.map((m) => m.id)).toEqual([
      "deployment",
      "providers",
      "features",
    ]);
  });

  it("currentStep argument does not affect the returned set", () => {
    canRunLocalMock.mockReturnValue(false);
    const a = getOnboardingNavMetas("deployment", false).map((m) => m.id);
    const b = getOnboardingNavMetas("providers", false).map((m) => m.id);
    const c = getOnboardingNavMetas("features", false).map((m) => m.id);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it("returns a fresh array (mutation of the result does not corrupt subsequent calls)", () => {
    canRunLocalMock.mockReturnValue(false);
    const first = getOnboardingNavMetas("deployment", false);
    first.length = 0;
    const second = getOnboardingNavMetas("deployment", false);
    expect(second.length).toBe(3);
  });
});

describe("shouldSkipConnectionStepsForCloudProvisionedContainer", () => {
  it("only true when cloudProvisioned AND step is deployment", () => {
    expect(
      shouldSkipConnectionStepsForCloudProvisionedContainer({
        currentStep: "deployment",
        cloudProvisionedContainer: true,
      }),
    ).toBe(true);

    for (const step of EXPECTED_ORDER) {
      if (step === "deployment") continue;
      expect(
        shouldSkipConnectionStepsForCloudProvisionedContainer({
          currentStep: step,
          cloudProvisionedContainer: true,
        }),
      ).toBe(false);
    }

    for (const step of EXPECTED_ORDER) {
      expect(
        shouldSkipConnectionStepsForCloudProvisionedContainer({
          currentStep: step,
          cloudProvisionedContainer: false,
        }),
      ).toBe(false);
    }
  });
});

describe("shouldSkipFeaturesStep", () => {
  it("is always false (current product behaviour: features always shown)", () => {
    for (const target of ["local", "remote", "elizacloud", ""]) {
      expect(
        shouldSkipFeaturesStep({ onboardingServerTarget: target }),
      ).toBe(false);
    }
  });
});

describe("shouldUseCloudOnboardingFastTrack", () => {
  it("cloudProvisionedContainer short-circuits everything else", () => {
    expect(
      shouldUseCloudOnboardingFastTrack({
        cloudProvisionedContainer: true,
        elizaCloudConnected: false,
        onboardingRunMode: "local",
        onboardingProvider: "openai",
      }),
    ).toBe(true);
  });

  it("not connected to cloud and not provisioned -> false", () => {
    expect(
      shouldUseCloudOnboardingFastTrack({
        cloudProvisionedContainer: false,
        elizaCloudConnected: false,
        onboardingRunMode: "",
        onboardingProvider: "",
      }),
    ).toBe(false);
  });

  it("connected to cloud with no local override -> true", () => {
    expect(
      shouldUseCloudOnboardingFastTrack({
        cloudProvisionedContainer: false,
        elizaCloudConnected: true,
        onboardingRunMode: "",
        onboardingProvider: "",
      }),
    ).toBe(true);
  });

  it("connected to cloud + local run mode + non-elizacloud provider -> false", () => {
    expect(
      shouldUseCloudOnboardingFastTrack({
        cloudProvisionedContainer: false,
        elizaCloudConnected: true,
        onboardingRunMode: "local",
        onboardingProvider: "openai",
      }),
    ).toBe(false);
  });

  it("connected to cloud + local run mode + elizacloud provider -> true", () => {
    expect(
      shouldUseCloudOnboardingFastTrack({
        cloudProvisionedContainer: false,
        elizaCloudConnected: true,
        onboardingRunMode: "local",
        onboardingProvider: "elizacloud",
      }),
    ).toBe(true);
  });

  it("connected to cloud + cloud run mode -> true regardless of provider", () => {
    expect(
      shouldUseCloudOnboardingFastTrack({
        cloudProvisionedContainer: false,
        elizaCloudConnected: true,
        onboardingRunMode: "cloud",
        onboardingProvider: "openai",
      }),
    ).toBe(true);
  });

  it("connected to cloud + local mode + empty provider -> true (no override active)", () => {
    expect(
      shouldUseCloudOnboardingFastTrack({
        cloudProvisionedContainer: false,
        elizaCloudConnected: true,
        onboardingRunMode: "local",
        onboardingProvider: "",
      }),
    ).toBe(true);
  });
});

describe("getFlaminaTopicForOnboardingStep", () => {
  it("providers -> provider", () => {
    expect(getFlaminaTopicForOnboardingStep("providers")).toBe("provider");
  });

  it("features -> features", () => {
    expect(getFlaminaTopicForOnboardingStep("features")).toBe("features");
  });

  it("deployment -> null", () => {
    expect(getFlaminaTopicForOnboardingStep("deployment")).toBeNull();
  });

  it.each(INVALID_STEPS)("invalid %j -> null", (bad) => {
    expect(
      getFlaminaTopicForOnboardingStep(bad as unknown as OnboardingStep),
    ).toBeNull();
  });
});

describe("inferOnboardingResumeStep (resume from persisted state)", () => {
  it("persistedStep wins over every other signal", () => {
    for (const step of EXPECTED_ORDER) {
      expect(
        inferOnboardingResumeStep({
          persistedStep: step,
          config: null,
        }),
      ).toBe(step);
      // even when partial config would otherwise force "providers"
      expect(
        inferOnboardingResumeStep({
          persistedStep: step,
          config: {
            deploymentTarget: { runtime: "remote", provider: "remote" },
          },
        }),
      ).toBe(step);
    }
  });

  it("no persisted step + no config -> deployment", () => {
    expect(
      inferOnboardingResumeStep({ persistedStep: null, config: null }),
    ).toBe("deployment");
    expect(
      inferOnboardingResumeStep({
        persistedStep: null,
        config: undefined,
      }),
    ).toBe("deployment");
    expect(inferOnboardingResumeStep({})).toBe("deployment");
  });

  it("no persisted step + empty config object -> deployment", () => {
    expect(
      inferOnboardingResumeStep({ persistedStep: null, config: {} }),
    ).toBe("deployment");
  });

  it("partial connection config (non-local runtime) -> providers", () => {
    expect(
      inferOnboardingResumeStep({
        persistedStep: null,
        config: {
          deploymentTarget: { runtime: "remote", provider: "remote" },
        },
      }),
    ).toBe("providers");
  });

  it("partial connection config (deploymentTarget key present) -> providers", () => {
    expect(
      inferOnboardingResumeStep({
        persistedStep: null,
        config: { deploymentTarget: { runtime: "local" } },
      }),
    ).toBe("providers");
  });

  it("partial connection config (linkedAccounts key present) -> providers", () => {
    expect(
      inferOnboardingResumeStep({
        persistedStep: null,
        config: { linkedAccounts: {} },
      }),
    ).toBe("providers");
  });

  it("hasPartialOnboardingConnectionConfig agrees with the resume decision", () => {
    const partial = {
      deploymentTarget: { runtime: "remote", provider: "remote" },
    } as Record<string, unknown>;
    expect(hasPartialOnboardingConnectionConfig(partial)).toBe(true);
    expect(hasPartialOnboardingConnectionConfig({})).toBe(false);
    expect(hasPartialOnboardingConnectionConfig(null)).toBe(false);
  });
});

describe("restartAgentAfterOnboarding", () => {
  it("delegates to client.restartAndWait with the provided timeout", async () => {
    const restartAndWait = vi.fn(async () => "running" as const);
    const result = await restartAgentAfterOnboarding(
      { restartAndWait } as never,
      5000,
    );
    expect(restartAndWait).toHaveBeenCalledTimes(1);
    expect(restartAndWait).toHaveBeenCalledWith(5000);
    expect(result).toBe("running");
  });

  it("uses the documented 120s default when no timeout is supplied", async () => {
    const restartAndWait = vi.fn(async () => "running" as const);
    await restartAgentAfterOnboarding({ restartAndWait } as never);
    expect(restartAndWait).toHaveBeenCalledWith(120_000);
  });
});

describe("fuzz: random walks", () => {
  type Op = "next" | "prev" | "jump";
  const ops: Op[] = ["next", "prev", "jump"];
  const SEED = 0xc0ffee;
  const WALKS = 200;

  it("200 deterministic walks of length 1-20 never escape the configured step set", () => {
    const rng = makeRng(SEED);
    for (let walk = 0; walk < WALKS; walk += 1) {
      const length = 1 + Math.floor(rng() * 20);
      let current: OnboardingStep = pick(rng, EXPECTED_ORDER);
      const trace: string[] = [current];

      for (let step = 0; step < length; step += 1) {
        const op = pick(rng, ops);

        if (op === "next") {
          const candidate = resolveOnboardingNextStep(current);
          if (candidate !== null) {
            expect(STEP_IDS).toContain(candidate);
            current = candidate;
          }
        } else if (op === "prev") {
          const candidate = resolveOnboardingPreviousStep(current);
          if (candidate !== null) {
            expect(STEP_IDS).toContain(candidate);
            current = candidate;
          }
        } else {
          const target = pick(rng, EXPECTED_ORDER);
          if (canRevertOnboardingTo({ current, target })) {
            // canRevertOnboardingTo is true only for strictly-earlier targets
            expect(getOnboardingStepIndex(target)).toBeLessThan(
              getOnboardingStepIndex(current),
            );
            current = target;
          }
        }

        trace.push(`${op}->${current}`);
        // safety net so a regression yields a readable failure rather than
        // a silent state escape
        expect(STEP_IDS, `walk=${walk} trace=${trace.join(",")}`).toContain(
          current,
        );
      }
    }
  });

  it("fuzz over invalid ids: next/prev/canRevert never throw and never return an unconfigured id", () => {
    const rng = makeRng(SEED ^ 0xdeadbeef);
    const universe = [
      ...EXPECTED_ORDER,
      ...INVALID_STEPS,
    ] as unknown as OnboardingStep[];

    for (let i = 0; i < WALKS; i += 1) {
      const current = pick(rng, universe);

      expect(() => resolveOnboardingNextStep(current)).not.toThrow();
      expect(() => resolveOnboardingPreviousStep(current)).not.toThrow();

      const nxt = resolveOnboardingNextStep(current);
      if (nxt !== null) expect(STEP_IDS).toContain(nxt);

      const prv = resolveOnboardingPreviousStep(current);
      if (prv !== null) expect(STEP_IDS).toContain(prv);

      const target = pick(rng, universe);
      expect(() =>
        canRevertOnboardingTo({ current, target }),
      ).not.toThrow();
    }
  });
});
