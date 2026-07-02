/**
 * Echo-assertion ratchet.
 *
 * `responseIncludesAny` / `responseIncludesAll` assert by case-insensitive
 * substring match against the agent's reply. When every keyword in the array
 * also appears in the scenario's own user turn text, the assertion is
 * "echo-satisfiable": the agent can pass by parroting the prompt, so the check
 * cannot fail for the real reason. These are weak assertions that should be
 * rewritten to assert the agent's *effect* (finalChecks / memory writes /
 * connector ledger), not words already present in the input.
 *
 * Rewriting the existing backlog requires per-scenario work with live runs
 * (tracked in #9310). This guard is a ratchet: it does not fix the backlog, but
 * it prevents it from growing. The count may only go DOWN. When you rewrite
 * echo-satisfiable scenarios, lower BASELINE to match. Adding a new
 * echo-satisfiable scenario turns this RED.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");

const SCENARIO_ROOTS = [
  "packages/test/scenarios",
  "plugins/plugin-personal-assistant/test/scenarios",
  "plugins/plugin-app-control/test/scenarios",
  "plugins/plugin-health/test/scenarios",
  "plugins/plugin-agent-orchestrator/test/scenarios",
].map((r) => resolve(repoRoot, r));

// Generic acknowledgement keywords are not meaningful "echo" even when present
// in input — they say nothing about the scenario's behaviour either way.
const STOPWORDS = new Set([
  "ok",
  "okay",
  "yes",
  "no",
  "done",
  "sure",
  "got it",
  "thanks",
]);

function walkScenarioFiles(dir: string): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith("_")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkScenarioFiles(full));
    } else if (entry.endsWith(".scenario.ts")) {
      out.push(full);
    }
  }
  return out;
}

const TEXT_LITERAL = /\btext:\s*"((?:[^"\\]|\\.)*)"/g;
const INCLUDES_ARRAY = /responseIncludes(?:Any|All):\s*\[([^\]]*)\]/g;
const STRING_LITERAL = /"((?:[^"\\]|\\.)*)"/g;

function isEchoSatisfiable(src: string): boolean {
  const corpus = [...src.matchAll(TEXT_LITERAL)]
    .map((m) => m[1].toLowerCase())
    .join("  ||  ");
  if (!corpus) return false;
  for (const arr of src.matchAll(INCLUDES_ARRAY)) {
    const keywords = [...arr[1].matchAll(STRING_LITERAL)]
      .map((m) => m[1].toLowerCase().trim())
      .filter(Boolean);
    if (keywords.length === 0) continue;
    // Echo-satisfiable iff every keyword in the array is present in the
    // scenario's own input text (so the assertion can never fail on echo).
    const everyKeywordEchoes = keywords.every((k) => corpus.includes(k));
    const hasMeaningfulKeyword = keywords.some((k) => !STOPWORDS.has(k));
    if (everyKeywordEchoes && hasMeaningfulKeyword) return true;
  }
  return false;
}

const echoFiles = SCENARIO_ROOTS.flatMap(walkScenarioFiles)
  .filter((f) => isEchoSatisfiable(readFileSync(f, "utf8")))
  .map((f) => relative(repoRoot, f));

// Current debt. Lower this as echo-satisfiable scenarios are rewritten to
// assert real effects (#9310). Never raise it.
// 237 -> 215: 30 scenarios rewritten outcome-asserting (20 PA chief-of-staff
// flows, 5 lifeops.hygiene, 5 executive-assistant) — see #9310/#10721/#10723.
// 215 -> 0: the remaining corpus-wide echo debt was rewritten outcome-asserting
// (114 PA chief-of-staff files, 26 connector certifications, 75 mixed-domain
// files across lifeops.*/reminders/todos/goals/health/relationships/...) —
// seeded-token grounding, approval end-state read-back, decoy responseExcludes,
// selectedActionArguments, definitionCountDelta + judge rubrics. The floor is
// now ZERO: any newly echo-satisfiable scenario is a regression, not debt.
const BASELINE = 0;

describe("echo-assertion ratchet", () => {
  it(`does not grow the echo-satisfiable scenario count beyond ${BASELINE}`, () => {
    if (echoFiles.length > BASELINE) {
      const overflow = echoFiles.slice(BASELINE);
      throw new Error(
        `echo-satisfiable scenarios grew to ${echoFiles.length} (baseline ${BASELINE}). ` +
          `New responseIncludesAny/All assertions whose keywords all appear in the scenario's own ` +
          `input text are echo-larp — assert the agent's effect instead. Likely offenders:\n` +
          overflow.join("\n"),
      );
    }
    expect(echoFiles.length).toBeLessThanOrEqual(BASELINE);
  });
});
