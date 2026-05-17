/**
 * LLM-as-judge — applies the scenario's responseRubric.judgePrompt against
 * the agent's final reply set to award up to +5 bonus points (aggregate).
 *
 * Uses the same Cerebras path as the live runner. If Cerebras isn't
 * configured we return a neutral pass=true (the bonus is opt-in via the
 * `--judge` flag).
 */

import type { JSONSchema } from "@elizaos/core";
import { callCerebras, isCerebrasConfigured } from "./llm-cerebras.ts";
import type { SimulatorState } from "./state.ts";
import type { Scenario } from "./types.ts";

const JUDGE_SCHEMA: JSONSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    pass: {
      type: "boolean",
      description: "Whether the agent's reply satisfies the rubric.",
    },
    reason: {
      type: "string",
      description: "One-sentence justification.",
    },
  },
  required: ["pass", "reason"],
};

const JUDGE_SYSTEM =
  "You are a strict but fair benchmark judge. Read the rubric and the agent's replies. Decide pass/fail. Output JSON only.";

export async function runJudge(args: {
  scenario: Scenario;
  finalState: SimulatorState;
  model?: string;
}): Promise<{ pass: boolean; reason: string }> {
  const { scenario, finalState, model } = args;
  if (!isCerebrasConfigured()) {
    return {
      pass: false,
      reason: "CEREBRAS_API_KEY not set — judge skipped (no bonus awarded)",
    };
  }
  const repliesBlock = scenario.setup.rooms
    .map((r) => {
      const replies = finalState.repliesInChannel(r.id);
      const body =
        replies.length === 0
          ? "(no replies in this channel)"
          : replies.map((reply) => `  - "${reply.text}"`).join("\n");
      return `[${r.id}]\n${body}`;
    })
    .join("\n");
  const user = [
    `# Rubric`,
    scenario.responseRubric.judgePrompt,
    "",
    `# Agent replies, grouped by channel`,
    repliesBlock,
    "",
    `# Notable end-state`,
    `- active threads: ${
      [...finalState.threads.values()]
        .filter((t) => t.status === "active")
        .map((t) => `${t.id}(${t.instruction})`)
        .join(" | ") || "(none)"
    }`,
    `- stopped threads: ${
      [...finalState.threads.values()]
        .filter((t) => t.status === "stopped")
        .map((t) => t.id)
        .join(", ") || "(none)"
    }`,
    `- emailsSent: ${finalState.external.emailsSent}`,
    "",
    "Output JSON only.",
  ].join("\n");
  try {
    const out = await callCerebras({
      systemPrompt: JUDGE_SYSTEM,
      messages: [{ role: "user", content: user }],
      schema: JUDGE_SCHEMA,
      model,
      timeoutMs: 20_000,
    });
    const parsed = out.parsed as unknown as { pass?: boolean; reason?: string };
    return {
      pass: !!parsed?.pass,
      reason:
        typeof parsed?.reason === "string"
          ? parsed.reason
          : "(no reason returned)",
    };
  } catch (err) {
    return {
      pass: false,
      reason: `judge call failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
