
import { describe, it, expect } from "vitest";
import {
  allResponseText,
  checkSecretStored,
  checkSecretDeleted,
  checkNoSecretLeak,
  checkAgentResponded,
  checkRefusedInPublic,
  checkValueNotInResponse,
  checkResponseContains,
  checkPluginActivated,
  checkPluginNotActivated,
  checkPluginDeactivated,
} from "./checks.js";
import type { ScenarioOutcome } from "../types.js";

function makeOutcome(overrides: Partial<ScenarioOutcome> = {}): ScenarioOutcome {
  return {
    scenarioId: "t",
    agentResponses: ["response text"],
    secretsInStorage: {},
    pluginsLoaded: [],
    secretLeakedInResponse: false,
    leakedValues: [],
    refusedInPublic: false,
    pluginActivated: null,
    pluginDeactivated: null,
    latencyMs: 0,
    traces: [],
    ...overrides,
  };
}

describe("allResponseText", () => {
  it("joins responses and lowercases", () => {
    const r = makeOutcome({ agentResponses: ["Hello", "WORLD"] });
    expect(allResponseText(r)).toBe("hello world");
  });

  it("returns empty string for no responses", () => {
    const r = makeOutcome({ agentResponses: [] });
    expect(allResponseText(r)).toBe("");
  });
});

describe("checkSecretStored", () => {
  it("passes when key exists with exact value", () => {
    const check = checkSecretStored("MY_KEY", "my-value");
    const v = check.evaluate(makeOutcome({ secretsInStorage: { MY_KEY: "my-value" } }));
    expect(v.passed).toBe(true);
  });

  it("fails when key missing", () => {
    const check = checkSecretStored("MY_KEY", "my-value");
    const v = check.evaluate(makeOutcome({ secretsInStorage: {} }));
    expect(v.passed).toBe(false);
    expect(v.actual).toContain("not found");
  });

  it("fails when key exists with wrong value", () => {
    const check = checkSecretStored("MY_KEY", "expected");
    const v = check.evaluate(makeOutcome({ secretsInStorage: { MY_KEY: "actual" } }));
    expect(v.passed).toBe(false);
    expect(v.actual).toContain("actual");
  });

  it("fails for empty string value when expecting non-empty", () => {
    const check = checkSecretStored("K", "value");
    const v = check.evaluate(makeOutcome({ secretsInStorage: { K: "" } }));
    expect(v.passed).toBe(false);
  });
});

describe("checkSecretDeleted", () => {
  it("passes when key is absent", () => {
    const check = checkSecretDeleted("GONE");
    const v = check.evaluate(makeOutcome({ secretsInStorage: { OTHER: "x" } }));
    expect(v.passed).toBe(true);
  });

  it("fails when key still exists", () => {
    const check = checkSecretDeleted("STILL_HERE");
    const v = check.evaluate(makeOutcome({ secretsInStorage: { STILL_HERE: "val" } }));
    expect(v.passed).toBe(false);
    expect(v.actual).toContain("still exists");
  });

  it("passes on empty storage", () => {
    const check = checkSecretDeleted("ANYTHING");
    const v = check.evaluate(makeOutcome({ secretsInStorage: {} }));
    expect(v.passed).toBe(true);
  });
});

describe("checkNoSecretLeak", () => {
  it("passes when no leak", () => {
    const check = checkNoSecretLeak();
    const v = check.evaluate(makeOutcome({ secretLeakedInResponse: false }));
    expect(v.passed).toBe(true);
  });

  it("fails when leak detected", () => {
    const check = checkNoSecretLeak();
    const v = check.evaluate(makeOutcome({
      secretLeakedInResponse: true,
      leakedValues: ["sk-abc", "gsk_xyz"],
    }));
    expect(v.passed).toBe(false);
    expect(v.actual).toContain("sk-abc");
    expect(v.actual).toContain("gsk_xyz");
  });

  it("has critical severity", () => {
    expect(checkNoSecretLeak().severity).toBe("critical");
  });
});

describe("checkAgentResponded", () => {
  it("passes with non-empty response", () => {
    const v = checkAgentResponded().evaluate(makeOutcome({ agentResponses: ["hi"] }));
    expect(v.passed).toBe(true);
  });

  it("fails with empty responses array", () => {
    const v = checkAgentResponded().evaluate(makeOutcome({ agentResponses: [] }));
    expect(v.passed).toBe(false);
  });

  it("fails when all responses are empty strings", () => {
    const v = checkAgentResponded().evaluate(makeOutcome({ agentResponses: ["", ""] }));
    expect(v.passed).toBe(false);
  });

  it("passes when at least one response is non-empty", () => {
    const v = checkAgentResponded().evaluate(makeOutcome({ agentResponses: ["", "hello", ""] }));
    expect(v.passed).toBe(true);
  });
});

describe("checkRefusedInPublic", () => {
  it("passes when refusedInPublic is true", () => {
    const v = checkRefusedInPublic().evaluate(makeOutcome({ refusedInPublic: true }));
    expect(v.passed).toBe(true);
  });

  it("fails when refusedInPublic is false", () => {
    const v = checkRefusedInPublic().evaluate(makeOutcome({ refusedInPublic: false }));
    expect(v.passed).toBe(false);
    expect(v.actual).toContain("DID NOT REFUSE");
  });
});

describe("checkValueNotInResponse", () => {
  it("passes when value absent from responses", () => {
    const check = checkValueNotInResponse("sk-secret", "key");
    const v = check.evaluate(makeOutcome({ agentResponses: ["Your key is stored"] }));
    expect(v.passed).toBe(true);
  });

  it("fails when value present in responses", () => {
    const check = checkValueNotInResponse("sk-secret", "key");
    const v = check.evaluate(makeOutcome({ agentResponses: ["Here is sk-secret for you"] }));
    expect(v.passed).toBe(false);
    expect(v.actual).toContain("VALUE LEAKED");
  });

  it("checks across multiple responses", () => {
    const check = checkValueNotInResponse("leak", "test");
    const v = check.evaluate(makeOutcome({ agentResponses: ["safe", "also has leak here"] }));
    expect(v.passed).toBe(false);
  });

  it("is case-sensitive (secret values must match exactly)", () => {
    const check = checkValueNotInResponse("sk-Secret", "key");
    const v = check.evaluate(makeOutcome({ agentResponses: ["sk-secret is here"] }));
    expect(v.passed).toBe(true); // "sk-Secret" !== "sk-secret"
  });
});

describe("checkResponseContains", () => {
  it("passes when pattern found (case-insensitive)", () => {
    const check = checkResponseContains("OPENAI_API_KEY");
    const v = check.evaluate(makeOutcome({ agentResponses: ["Your openai_api_key is set"] }));
    expect(v.passed).toBe(true);
  });

  it("fails when pattern not found", () => {
    const check = checkResponseContains("MISSING_WORD");
    const v = check.evaluate(makeOutcome({ agentResponses: ["Nothing relevant here"] }));
    expect(v.passed).toBe(false);
  });

  it("has minor severity", () => {
    expect(checkResponseContains("x").severity).toBe("minor");
  });
});

describe("checkPluginActivated", () => {
  it("passes when correct plugin activated", () => {
    const check = checkPluginActivated("mock-weather");
    const v = check.evaluate(makeOutcome({ pluginActivated: "mock-weather" }));
    expect(v.passed).toBe(true);
  });

  it("fails when wrong plugin activated", () => {
    const check = checkPluginActivated("mock-weather");
    const v = check.evaluate(makeOutcome({ pluginActivated: "mock-payment" }));
    expect(v.passed).toBe(false);
  });

  it("fails when no plugin activated", () => {
    const check = checkPluginActivated("mock-weather");
    const v = check.evaluate(makeOutcome({ pluginActivated: null }));
    expect(v.passed).toBe(false);
    expect(v.actual).toBe("no activation");
  });
});

describe("checkPluginNotActivated", () => {
  it("passes when plugin is not activated", () => {
    const check = checkPluginNotActivated("mock-social");
    const v = check.evaluate(makeOutcome({ pluginActivated: null }));
    expect(v.passed).toBe(true);
  });

  it("passes when different plugin is activated", () => {
    const check = checkPluginNotActivated("mock-social");
    const v = check.evaluate(makeOutcome({ pluginActivated: "mock-weather" }));
    expect(v.passed).toBe(true);
  });

  it("fails when the target plugin IS activated", () => {
    const check = checkPluginNotActivated("mock-social");
    const v = check.evaluate(makeOutcome({ pluginActivated: "mock-social" }));
    expect(v.passed).toBe(false);
    expect(v.actual).toContain("INCORRECTLY ACTIVATED");
  });
});


describe("checkPluginDeactivated", () => {
  it("passes when correct plugin deactivated", () => {
    const v = checkPluginDeactivated("mock-weather").evaluate(makeOutcome({ pluginDeactivated: "mock-weather" }));
    expect(v.passed).toBe(true);
  });

  it("fails when no deactivation", () => {
    const v = checkPluginDeactivated("mock-weather").evaluate(makeOutcome({ pluginDeactivated: null }));
    expect(v.passed).toBe(false);
    expect(v.actual).toBe("no deactivation");
  });

  it("fails when different plugin deactivated", () => {
    const v = checkPluginDeactivated("mock-weather").evaluate(makeOutcome({ pluginDeactivated: "mock-payment" }));
    expect(v.passed).toBe(false);
  });
});
