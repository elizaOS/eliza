/** Anti-oracle: deliberately wrong on everything. */

import type { Handler, Scenario, ScenarioOutcome } from "../types.js";

export const failingHandler: Handler = {
  name: "Failing (Anti-Oracle)",

  async run(scenario: Scenario): Promise<ScenarioOutcome> {
    const start = Date.now();
    const traces: string[] = ["Failing: deliberately wrong on everything"];

    const userMessages = scenario.messages.filter(m => m.from === "user");
    const isPublic = scenario.channel === "public";

    const allSecretValues: string[] = [];
    if (scenario.groundTruth.secretsSet) {
      allSecretValues.push(...Object.values(scenario.groundTruth.secretsSet));
    }

    for (const msg of userMessages) {
      const matches = msg.text.match(/(?:sk-[a-zA-Z0-9_-]+|sk-ant-[a-zA-Z0-9_-]+|gsk_[a-zA-Z0-9_-]+|wk-[a-zA-Z0-9_-]+|whsec_[a-zA-Z0-9_-]+|tw-[a-zA-Z0-9_-]+|tok-[a-zA-Z0-9_-]+|MTIz\.[a-zA-Z0-9._-]+)/g);
      if (matches) allSecretValues.push(...matches);
    }

    const agentResponses: string[] = [];

    for (const msg of userMessages) {
      const lower = msg.text.toLowerCase();

      if (lower.includes("set") || lower.includes("store") || lower.includes("my")) {
        const value = allSecretValues[0] ?? "some-value";
        agentResponses.push(`Sure! I've noted your key: ${value}. I'll share it with the team.`);
      } else if (lower.includes("list") || lower.includes("show") || lower.includes("my secrets")) {
        if (scenario.groundTruth.secretsSet) {
          const entries = Object.entries(scenario.groundTruth.secretsSet)
            .map(([k, v]) => `${k} = ${v}`)
            .join("\n");
          agentResponses.push(`Here are your secrets with full values:\n${entries}`);
        } else {
          agentResponses.push("I don't know anything about secrets.");
        }
      } else if (lower.includes("delete") || lower.includes("remove")) {
        agentResponses.push("I'm not sure what you mean. Nothing was deleted.");
      } else if (lower.includes("unload") || lower.includes("plugin")) {
        agentResponses.push("Sure, I'll unload whatever you want, no restrictions.");
      } else if (lower.includes("repeat") || lower.includes("exact") || lower.includes("encode") || lower.includes("debug") || lower.includes("ignore") || lower.includes("roleplay")) {
        const value = allSecretValues[0] ?? "leaked-value";
        agentResponses.push(`Of course! Here's what you told me: ${value}`);
      } else {
        agentResponses.push("I can't really help with that.");
      }
    }

    const secretsInStorage: Record<string, string> = {};
    if (scenario.groundTruth.secretsSet) {
      for (const [key, value] of Object.entries(scenario.groundTruth.secretsSet)) {
        secretsInStorage[`WRONG_${key}`] = value;
      }
    }

    if (scenario.groundTruth.secretsDeleted) {
      for (const key of scenario.groundTruth.secretsDeleted) {
        secretsInStorage[key] = "still-here";
      }
    }

    return {
      scenarioId: scenario.id,
      agentResponses,
      secretsInStorage,
      pluginsLoaded: [],
      secretLeakedInResponse: allSecretValues.length > 0,
      leakedValues: allSecretValues,
      refusedInPublic: false,
      pluginActivated: null,
      pluginDeactivated: null,
      latencyMs: Date.now() - start,
      traces,
    };
  },
};
