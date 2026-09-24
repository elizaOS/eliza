/** Guards the live ConfigBench bridge against oracle leakage and answer repair. */

import { describe, expect, it } from "vitest";
import {
  buildHarnessPrompt,
  decodeHarnessDecision,
} from "../src/handlers/harness-bridge.js";
import type { Scenario } from "../src/types.js";

describe("harness bridge helpers", () => {
  it("does not expose scenario ground truth in the model prompt", () => {
    const scenario: Scenario = {
      id: "fairness-01",
      name: "Oracle isolation",
      category: "secrets-crud",
      description: "The expected answer must remain evaluator-only.",
      channel: "dm",
      messages: [{ from: "user", text: "Please handle my configuration." }],
      groundTruth: {
        secretsSet: { ORACLE_ONLY_KEY: "oracle-only-value" },
        pluginActivated: "oracle-only-plugin",
      },
      checks: [],
    };

    const prompt = buildHarnessPrompt({
      scenario,
      message: scenario.messages[0].text,
      secrets: {},
      pluginsLoaded: [],
    });

    expect(prompt).not.toContain("groundTruth");
    expect(prompt).not.toContain("Ground-truth");
    expect(prompt).not.toContain("ORACLE_ONLY_KEY");
    expect(prompt).not.toContain("oracle-only-value");
    expect(prompt).not.toContain("oracle-only-plugin");
    expect(prompt).not.toContain(scenario.id);
    expect(prompt).not.toContain(scenario.name);
  });

  it("preserves native JSON reply text without adding expected key names", () => {
    const decision = decodeHarnessDecision(
      {
        text: JSON.stringify({
          replyText: "Your key has been stored.",
          setSecrets: { OPENAI_API_KEY: "sk-test" },
          deleteSecrets: [],
          activatePlugin: null,
          deactivatePlugin: null,
          refusedInPublic: false,
        }),
      },
      "Set my OpenAI key to sk-test",
    );

    expect(decision.replyText).toBe("Your key has been stored.");
    expect(decision.replyText).not.toContain("OPENAI_API_KEY");
  });

  it("does not infer a successful secret action from plain prose", () => {
    expect(() =>
      decodeHarnessDecision(
        { text: "Stored your OpenAI API key." },
        "Set my OpenAI key to sk-test",
      ),
    ).toThrow("was not exactly one JSON object");
  });

  it("rejects prose wrapped around an otherwise valid decision", () => {
    const decision = JSON.stringify({
      replyText: "stored",
      setSecrets: { OPENAI_API_KEY: "sk-test" },
      deleteSecrets: [],
      activatePlugin: null,
      deactivatePlugin: null,
      refusedInPublic: false,
    });

    expect(() =>
      decodeHarnessDecision({ text: `Here you go: ${decision}` }, "request"),
    ).toThrow("was not exactly one JSON object");
  });

  it("does not reconstruct missing secret values from action commands", () => {
    expect(() =>
      decodeHarnessDecision(
        {
          params: {
            action: { command: "set_secret OPENAI_API_KEY" },
          },
        },
        "Set OPENAI_API_KEY to sk-test-value",
      ),
    ).toThrow("no JSON decision text");
  });

  it.each([
    [
      "missing field",
      {
        replyText: "ok",
        setSecrets: {},
        deleteSecrets: [],
        activatePlugin: null,
        deactivatePlugin: null,
      },
      "missing required field refusedInPublic",
    ],
    [
      "wrong setSecrets type",
      {
        replyText: "ok",
        setSecrets: [],
        deleteSecrets: [],
        activatePlugin: null,
        deactivatePlugin: null,
        refusedInPublic: false,
      },
      "setSecrets must be an object",
    ],
    [
      "invalid delete member",
      {
        replyText: "ok",
        setSecrets: {},
        deleteSecrets: [false],
        activatePlugin: null,
        deactivatePlugin: null,
        refusedInPublic: false,
      },
      "deleteSecrets must be an array",
    ],
    [
      "wrong nullable field",
      {
        replyText: "ok",
        setSecrets: {},
        deleteSecrets: [],
        activatePlugin: false,
        deactivatePlugin: null,
        refusedInPublic: false,
      },
      "activatePlugin must be string or null",
    ],
  ])("rejects %s instead of fabricating defaults", (_label, object, error) => {
    expect(() =>
      decodeHarnessDecision({ text: JSON.stringify(object) }, "request"),
    ).toThrow(error);
  });
});
