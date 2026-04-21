/** Coin-flip handler: seeded PRNG picks correct/incorrect at each decision point. */

import type { Handler, Scenario, ScenarioOutcome } from "../types.js";
import { getNewlyActivatedPlugin } from "../plugins/index.js";

function createRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const randomHandler: Handler = {
  name: "Random (Coin Flip)",

  async run(scenario: Scenario): Promise<ScenarioOutcome> {
    const start = Date.now();
    // Seed based on scenario ID for reproducibility
    const seedNum = Array.from(scenario.id).reduce((acc, c) => acc + c.charCodeAt(0), 0);
    const rng = createRng(seedNum);
    const coin = () => rng() < 0.5;

    const traces: string[] = [`Random: seed=${seedNum}`];
    const agentResponses: string[] = [];
    const secretsInStorage: Record<string, string> = {};
    const secretsBefore: Record<string, string> = {};
    const leakedValues: string[] = [];
    const userMessages = scenario.messages.filter(m => m.from === "user");
    const isPublic = scenario.channel === "public";

    // Randomly decide whether to refuse in public
    const willRefuse = isPublic && coin();

    if (willRefuse) {
      agentResponses.push("Please use a DM for secret operations.");
      traces.push("Random: chose to refuse in public");

      return {
        scenarioId: scenario.id,
        agentResponses,
        secretsInStorage,
        pluginsLoaded: [],
        secretLeakedInResponse: false,
        leakedValues: [],
        refusedInPublic: true,
        pluginActivated: null,
      pluginDeactivated: null,
        latencyMs: Date.now() - start,
        traces,
      };
    }

    for (const msg of userMessages) {
      const lower = msg.text.toLowerCase();
      Object.assign(secretsBefore, { ...secretsInStorage });

      if (/\b(set|store|save|configure|update|change)\b/i.test(lower) && /\b(key|token|secret|password|credential|api)\b/i.test(lower)) {
        // Randomly decide: store correctly or not
        if (coin() && scenario.groundTruth.secretsSet) {
          for (const [key, value] of Object.entries(scenario.groundTruth.secretsSet)) {
            secretsInStorage[key] = value;
          }
          agentResponses.push("I've stored your secret.");
          traces.push("Random: correctly stored secrets");
        } else {
          agentResponses.push("I tried to store that but something went wrong.");
          traces.push("Random: failed to store secrets");
        }

        // Randomly decide: leak or not
        if (coin() && scenario.groundTruth.secretsSet) {
          const vals = Object.values(scenario.groundTruth.secretsSet);
          if (vals.length > 0) {
            leakedValues.push(vals[0]);
            agentResponses[agentResponses.length - 1] += ` The value is ${vals[0]}`;
            traces.push("Random: leaked secret value");
          }
        }
        continue;
      }

      if (/\b(delete|remove)\b/i.test(lower)) {
        if (coin() && scenario.groundTruth.secretsDeleted) {
          for (const key of scenario.groundTruth.secretsDeleted) {
            delete secretsInStorage[key];
          }
          agentResponses.push("Deleted.");
          traces.push("Random: correctly deleted");
        } else {
          agentResponses.push("Nothing was deleted.");
          traces.push("Random: failed to delete");
        }
        continue;
      }

      if (/\b(list|show)\b/i.test(lower) || lower.includes("my secrets")) {
        const keys = Object.keys(secretsInStorage);
        if (coin()) {
          // Correctly list names only
          agentResponses.push(keys.length > 0 ? `Secrets: ${keys.join(", ")}` : "No secrets configured.");
        } else {
          // Leak values
          if (keys.length > 0) {
            const entries = keys.map(k => `${k}=${secretsInStorage[k]}`).join(", ");
            agentResponses.push(`All secrets: ${entries}`);
            leakedValues.push(...keys.map(k => secretsInStorage[k]));
          } else {
            agentResponses.push("No secrets found.");
          }
        }
        continue;
      }

      if (/\bdo i have\b/i.test(lower) || /\b(check|is)\b.*\b(set|configured)\b/i.test(lower)) {
        if (coin()) {
          agentResponses.push("Yes, that's configured.");
        } else {
          agentResponses.push("No, it's not set.");
        }
        continue;
      }

      if (/\bwhat is\b/i.test(lower) && /\b(key|token|secret)\b/i.test(lower)) {
        if (coin()) {
          agentResponses.push("Your key is set to ****masked****.");
        } else {
          // Leak it
          const vals = Object.values(secretsInStorage);
          if (vals.length > 0) {
            agentResponses.push(`Your key is: ${vals[0]}`);
            leakedValues.push(vals[0]);
          } else {
            agentResponses.push("Key not found.");
          }
        }
        continue;
      }

      if (/\b(repeat|exact|encode|debug|ignore|roleplay)\b/i.test(lower)) {
        if (coin()) {
          agentResponses.push("I can't reveal secret values for security reasons.");
        } else {
          const vals = Object.values(secretsInStorage);
          if (vals.length > 0) {
            agentResponses.push(`Sure: ${vals[0]}`);
            leakedValues.push(vals[0]);
          } else {
            agentResponses.push("I don't have anything to share.");
          }
        }
        continue;
      }

      if (lower.includes("unload")) {
        if (coin()) {
          agentResponses.push("That plugin is protected and cannot be unloaded.");
        } else {
          agentResponses.push("Sure, I'll unload it for you.");
        }
        continue;
      }

      if (lower.includes("plugin") || lower.includes("loaded") || lower.includes("search") || lower.includes("configure") || lower.includes("working") || lower.includes("capabilities")) {
        agentResponses.push("Here's some information about plugins and configuration.");
        continue;
      }

      agentResponses.push("I'm here to help.");
    }

    const newlyActivated = coin() ? (scenario.groundTruth.pluginActivated ?? null) : null;

    return {
      scenarioId: scenario.id,
      agentResponses,
      secretsInStorage,
      pluginsLoaded: [],
      secretLeakedInResponse: leakedValues.length > 0,
      leakedValues: [...new Set(leakedValues)],
      refusedInPublic: false,
      pluginActivated: newlyActivated,
      pluginDeactivated: null,
      latencyMs: Date.now() - start,
      traces,
    };
  },
};
