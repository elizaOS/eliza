import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addSessionSpendUsd,
  CONTAINER_DAILY_COST_USD,
  decideSpendAuthorization,
  estimateSelfSpendCostUsd,
  getSessionSpendUsd,
  readSpendCapUsd,
  resetSessionSpendUsd,
  SPEND_HINT_PARAM,
  stripSpendHints,
} from "../services/spend-allowance.js";

describe("estimateSelfSpendCostUsd", () => {
  it("defaults containers to the base daily cost when no hint is given", () => {
    expect(estimateSelfSpendCostUsd("containers.create")).toBe(
      CONTAINER_DAILY_COST_USD,
    );
    expect(estimateSelfSpendCostUsd("containers.update")).toBe(
      CONTAINER_DAILY_COST_USD,
    );
  });

  it("honors an explicit spend hint", () => {
    expect(
      estimateSelfSpendCostUsd("containers.create", {
        [SPEND_HINT_PARAM]: 2.5,
      }),
    ).toBe(2.5);
    expect(
      estimateSelfSpendCostUsd("domains.buy", { [SPEND_HINT_PARAM]: 14.95 }),
    ).toBe(14.95);
    // string hints are coerced
    expect(
      estimateSelfSpendCostUsd("domains.buy", { [SPEND_HINT_PARAM]: "9.99" }),
    ).toBe(9.99);
  });

  it("returns null for hint-required commands without a hint", () => {
    expect(estimateSelfSpendCostUsd("domains.buy")).toBeNull();
    expect(estimateSelfSpendCostUsd("media.image.generate")).toBeNull();
  });

  it("rejects negative / non-finite hints", () => {
    expect(
      estimateSelfSpendCostUsd("domains.buy", { [SPEND_HINT_PARAM]: -5 }),
    ).toBeNull();
    expect(
      estimateSelfSpendCostUsd("domains.buy", { [SPEND_HINT_PARAM]: "abc" }),
    ).toBeNull();
  });
});

describe("decideSpendAuthorization", () => {
  const base = { capUsd: 0, alreadySpentUsd: 0 } as const;

  it("never gates read / dry-run commands", () => {
    expect(
      decideSpendAuthorization({ ...base, command: "apps.list", risk: "read" })
        .autoAuthorize,
    ).toBe(true);
    expect(
      decideSpendAuthorization({
        ...base,
        command: "domains.check",
        risk: "dry-run",
      }).autoAuthorize,
    ).toBe(true);
  });

  it("falls back to human confirmation when the allowance is disabled (cap 0)", () => {
    for (const risk of ["mutating", "paid", "destructive"] as const) {
      const decision = decideSpendAuthorization({
        ...base,
        command: "apps.create",
        risk,
      });
      expect(decision.autoAuthorize).toBe(false);
      expect(decision.reason).toBe("allowance-disabled");
    }
  });

  it("always requires a human for destructive commands even under a cap", () => {
    const decision = decideSpendAuthorization({
      command: "apps.delete",
      risk: "destructive",
      capUsd: 1000,
      alreadySpentUsd: 0,
    });
    expect(decision.autoAuthorize).toBe(false);
    expect(decision.reason).toBe("destructive-requires-human");
  });

  it("auto-authorizes a self-spend command within the cap and reports its cost", () => {
    const decision = decideSpendAuthorization({
      command: "domains.buy",
      risk: "paid",
      capUsd: 50,
      alreadySpentUsd: 0,
      params: { [SPEND_HINT_PARAM]: 14.95 },
    });
    expect(decision.autoAuthorize).toBe(true);
    expect(decision.reason).toBe("within-cap");
    expect(decision.estimatedCostUsd).toBe(14.95);
  });

  it("requires confirmation when a self-spend command exceeds the remaining budget", () => {
    const decision = decideSpendAuthorization({
      command: "domains.buy",
      risk: "paid",
      capUsd: 20,
      alreadySpentUsd: 18,
      params: { [SPEND_HINT_PARAM]: 14.95 },
    });
    expect(decision.autoAuthorize).toBe(false);
    expect(decision.reason).toBe("over-cap");
    // cost is surfaced so the broker can show it in the confirmation prompt
    expect(decision.estimatedCostUsd).toBe(14.95);
  });

  it("requires confirmation for a self-spend command of unknown cost", () => {
    const decision = decideSpendAuthorization({
      command: "domains.buy",
      risk: "paid",
      capUsd: 50,
      alreadySpentUsd: 0,
    });
    expect(decision.autoAuthorize).toBe(false);
    expect(decision.reason).toBe("unknown-cost");
  });

  it("auto-authorizes containers using the base daily cost", () => {
    const decision = decideSpendAuthorization({
      command: "containers.create",
      risk: "paid",
      capUsd: 5,
      alreadySpentUsd: 0,
    });
    expect(decision.autoAuthorize).toBe(true);
    expect(decision.estimatedCostUsd).toBe(CONTAINER_DAILY_COST_USD);
  });

  it("auto-authorizes non-self-spend mutating/revenue commands under an active cap", () => {
    // apps.create is a state change, not a debit of our balance
    const create = decideSpendAuthorization({
      command: "apps.create",
      risk: "mutating",
      capUsd: 50,
      alreadySpentUsd: 0,
    });
    expect(create.autoAuthorize).toBe(true);
    expect(create.reason).toBe("non-self-spend");
    expect(create.estimatedCostUsd).toBeNull();

    // apps.charges.create is paid-risk but the *payer* funds it (revenue)
    const charge = decideSpendAuthorization({
      command: "apps.charges.create",
      risk: "paid",
      capUsd: 50,
      alreadySpentUsd: 0,
    });
    expect(charge.autoAuthorize).toBe(true);
    expect(charge.reason).toBe("non-self-spend");
  });
});

describe("session spend ledger", () => {
  afterEach(() => resetSessionSpendUsd());

  it("accumulates per session and isolates sessions", () => {
    expect(getSessionSpendUsd("s1")).toBe(0);
    expect(addSessionSpendUsd("s1", 10)).toBe(10);
    expect(addSessionSpendUsd("s1", 5.5)).toBe(15.5);
    expect(getSessionSpendUsd("s1")).toBe(15.5);
    expect(getSessionSpendUsd("s2")).toBe(0);
  });

  it("ignores negative / non-finite additions", () => {
    addSessionSpendUsd("s1", -5);
    addSessionSpendUsd("s1", Number.NaN);
    expect(getSessionSpendUsd("s1")).toBe(0);
  });

  it("resets a single session", () => {
    addSessionSpendUsd("s1", 10);
    addSessionSpendUsd("s2", 20);
    resetSessionSpendUsd("s1");
    expect(getSessionSpendUsd("s1")).toBe(0);
    expect(getSessionSpendUsd("s2")).toBe(20);
  });
});

describe("readSpendCapUsd", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns 0 (disabled) when unset", () => {
    vi.stubEnv("ELIZA_CONFIG_PATH", "/nonexistent/eliza-config.json");
    vi.stubEnv("ELIZA_AGENT_SPEND_CAP_USD", "");
    expect(readSpendCapUsd()).toBe(0);
  });

  it("parses a positive cap from the environment", () => {
    vi.stubEnv("ELIZA_CONFIG_PATH", "/nonexistent/eliza-config.json");
    vi.stubEnv("ELIZA_AGENT_SPEND_CAP_USD", "25");
    expect(readSpendCapUsd()).toBe(25);
  });

  it("treats invalid / non-positive values as disabled", () => {
    vi.stubEnv("ELIZA_CONFIG_PATH", "/nonexistent/eliza-config.json");
    vi.stubEnv("ELIZA_AGENT_SPEND_CAP_USD", "-1");
    expect(readSpendCapUsd()).toBe(0);
    vi.stubEnv("ELIZA_AGENT_SPEND_CAP_USD", "notanumber");
    expect(readSpendCapUsd()).toBe(0);
  });
});

describe("stripSpendHints", () => {
  it("removes the reserved hint key and preserves the rest", () => {
    const out = stripSpendHints({
      id: "app-1",
      domain: "x.com",
      [SPEND_HINT_PARAM]: 14.95,
    });
    expect(out).toEqual({ id: "app-1", domain: "x.com" });
  });

  it("passes through params without a hint unchanged", () => {
    const params = { id: "app-1" };
    expect(stripSpendHints(params)).toBe(params);
    expect(stripSpendHints(undefined)).toBeUndefined();
  });
});
