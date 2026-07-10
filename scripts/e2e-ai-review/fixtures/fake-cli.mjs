#!/usr/bin/env node
/**
 * Deterministic stand-in for a reviewer CLI, used as the `ELIZA_AI_REVIEW_CMD`
 * seam when exercising `run.mjs` without a real model: reads the prompt from
 * stdin, emits some surrounding prose (so the last-JSON-object extraction is
 * actually exercised), then a contract-valid verdict derived from the
 * manifest status embedded in the prompt. `FAKE_CLI_MODE=quota` simulates a
 * quota failure; `FAKE_CLI_MODE=garbage` emits no JSON (exercises the
 * nudge-retry → needs-eyeball path).
 */

import process from "node:process";

const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const prompt = Buffer.concat(chunks).toString("utf8");
  const mode = process.env.FAKE_CLI_MODE ?? "verdict";

  if (mode === "quota") {
    process.stderr.write("error: usage limit reached for this plan\n");
    process.exit(1);
  }
  if (mode === "garbage") {
    process.stdout.write(
      "I looked at the artifacts and everything seems fine to me.\n",
    );
    process.exit(0);
  }

  const failed = /"status":\s*"failed"/.test(prompt);
  const verdict = failed
    ? {
        verdict: "fail",
        confidence: 0.85,
        findings: [
          {
            severity: "major",
            area: "app",
            summary:
              "Send button throws on click; message never reaches the agent",
            evidence:
              "console log tail shows 'TypeError: cannot read properties of null' at submit; network log has no POST /api/messages",
            suggestedFix:
              "guard the null composer ref before dispatching submit",
            files: ["packages/ui/src/components/chat/Composer.tsx"],
          },
        ],
        notes:
          "Deterministic fixture verdict: the failed manifest maps to a fail.",
      }
    : {
        verdict: "pass",
        confidence: 0.95,
        findings: [],
        notes:
          "Deterministic fixture verdict: artifacts consistent with a healthy pass.",
      };

  process.stdout.write("Reviewing the artifact bundle now...\n");
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  process.stdout.write("tokens used: 1234\n");
});
