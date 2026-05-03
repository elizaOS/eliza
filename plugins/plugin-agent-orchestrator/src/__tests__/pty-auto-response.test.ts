import type { IAgentRuntime } from "@elizaos/core";
import type { AutoResponseRule } from "pty-manager";
import { describe, expect, it } from "vitest";
import { pushDefaultRules } from "../services/pty-auto-response.js";
import { buildSpawnConfig } from "../services/pty-spawn.js";

function createRuntime(): IAgentRuntime {
  return {
    getSetting: () => undefined,
  } as unknown as IAgentRuntime;
}

describe("pushDefaultRules", () => {
  it("selects the Codex workspace trust approval option explicitly", async () => {
    const captured: Array<{ sessionId: string; rule: AutoResponseRule }> = [];
    const manager = {
      addAutoResponseRule(sessionId: string, rule: AutoResponseRule) {
        captured.push({ sessionId, rule });
      },
    };

    await pushDefaultRules(
      {
        manager: manager as never,
        usingBunWorker: false,
        runtime: createRuntime(),
        log: () => undefined,
      },
      "session-1",
      "codex",
    );

    const trustRule = captured.find(({ rule }) =>
      /workspace trust/i.test(rule.description ?? ""),
    );

    expect(trustRule).toMatchObject({
      sessionId: "session-1",
      rule: {
        responseType: "keys",
        keys: ["1", "enter"],
        safe: true,
      },
    });
  });

  it("keeps Codex on the current model when rate-limit model prompts appear", async () => {
    const captured: Array<{ sessionId: string; rule: AutoResponseRule }> = [];
    const manager = {
      addAutoResponseRule(sessionId: string, rule: AutoResponseRule) {
        captured.push({ sessionId, rule });
      },
    };

    await pushDefaultRules(
      {
        manager: manager as never,
        usingBunWorker: false,
        runtime: createRuntime(),
        log: () => undefined,
      },
      "session-1",
      "codex",
    );

    const hideFutureRule = captured.find(({ rule }) =>
      /hide future model-switch reminders/i.test(rule.description ?? ""),
    );
    expect(hideFutureRule).toMatchObject({
      sessionId: "session-1",
      rule: {
        responseType: "keys",
        keys: ["3", "enter"],
        safe: true,
      },
    });
    expect(
      hideFutureRule?.rule.pattern.test(
        "2. Keep current model 3. Keep current model (never show again) Hide future rate limit reminders about switching models. Press enter to confirm",
      ),
    ).toBe(true);

    const keepRule = captured.find(({ rule }) =>
      /routine model-switch reminder/i.test(rule.description ?? ""),
    );
    expect(keepRule).toMatchObject({
      sessionId: "session-1",
      rule: {
        responseType: "keys",
        keys: ["2", "enter"],
        safe: true,
      },
    });
    expect(
      keepRule?.rule.pattern.test(
        "Switch to the efficient model for simpler coding tasks. 2. Keep current model",
      ),
    ).toBe(true);
    expect(
      keepRule?.rule.pattern.test(
        "2. Keep current model 3. Keep current model (never show again)",
      ),
    ).toBe(false);
  });
});

describe("buildSpawnConfig", () => {
  it("overrides Codex adapter startup prompts before the process starts", () => {
    const config = buildSpawnConfig(
      "session-1",
      {
        name: "codex",
        agentType: "codex",
        approvalPreset: "autonomous",
      },
      "/tmp/workdir",
    );

    expect(config.ruleOverrides).toMatchObject({
      "update.?available.*->|update.?now|skip.?until.?next.?version": {
        responseType: "keys",
        keys: ["2", "enter"],
        once: true,
      },
      "do.?you.?trust.?the.?contents|trust.?this.?directory|yes,?.?continue|prompt.?injection":
        {
          responseType: "keys",
          keys: ["1", "enter"],
          once: true,
        },
    });
    const overrides = Object.values(config.ruleOverrides ?? {});
    expect(
      overrides.find((rule) =>
        /hide future model-switch reminders/i.test(rule.description ?? ""),
      ),
    ).toMatchObject({
      responseType: "keys",
      keys: ["3", "enter"],
    });
    expect(
      overrides.find((rule) =>
        /routine model-switch reminder/i.test(rule.description ?? ""),
      ),
    ).toMatchObject({
      responseType: "keys",
      keys: ["2", "enter"],
    });
    expect(config.adapterConfig?.approvalPreset).toBeUndefined();
  });
});
