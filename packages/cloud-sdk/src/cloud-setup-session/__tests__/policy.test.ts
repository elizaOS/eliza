import { describe, expect, it } from "vitest";
import { DEFAULT_SETUP_POLICY, isActionAllowed } from "../policy.js";
import type { SetupActionPolicy } from "../types.js";

describe("DEFAULT_SETUP_POLICY", () => {
  it("permits the documented setup-only actions", () => {
    for (const action of [
      "REPLY",
      "EXTRACT_OWNER_FACT",
      "ASK_FOR_LANGUAGE",
      "OFFER_TUTORIAL_STEP",
      "OPEN_SETTINGS_VIEW",
    ]) {
      expect(isActionAllowed(action, DEFAULT_SETUP_POLICY)).toBe(true);
    }
  });

  it("rejects unrelated actions", () => {
    expect(isActionAllowed("SEND_EMAIL", DEFAULT_SETUP_POLICY)).toBe(false);
    expect(isActionAllowed("EXECUTE_BASH", DEFAULT_SETUP_POLICY)).toBe(false);
    expect(isActionAllowed("", DEFAULT_SETUP_POLICY)).toBe(false);
  });

  it("caps budgets to keep the pre-container agent cheap", () => {
    expect(DEFAULT_SETUP_POLICY.budgets.maxTokensPerTurn).toBeLessThanOrEqual(
      2000,
    );
    expect(DEFAULT_SETUP_POLICY.budgets.maxToolCallsPerTurn).toBeLessThanOrEqual(
      4,
    );
    expect(DEFAULT_SETUP_POLICY.budgets.maxTurns).toBeLessThanOrEqual(40);
  });
});

describe("isActionAllowed with custom policy", () => {
  it("honors the supplied allow-list", () => {
    const policy: SetupActionPolicy = {
      allowList: ["ONLY_THIS"],
      budgets: {
        maxTokensPerTurn: 100,
        maxToolCallsPerTurn: 1,
        maxTurns: 1,
      },
    };
    expect(isActionAllowed("ONLY_THIS", policy)).toBe(true);
    expect(isActionAllowed("REPLY", policy)).toBe(false);
  });
});
