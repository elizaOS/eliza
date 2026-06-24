/**
 * Corpus assertion guard.
 *
 * The scenario-runner runs a scenario's turns and only fails when an assertion
 * fails. A scenario with no enforceable assertion therefore passes vacuously —
 * it proves nothing while counting as green coverage. This guard makes that
 * failure mode impossible to (re)introduce.
 *
 * Two invariants enforced here:
 *  1. No `pr-deterministic` scenario may lack an enforceable assertion. The
 *     pr-deterministic lane is the merge-blocking PR gate; a vacuous scenario
 *     there is false confidence on every PR. "Enforceable" means a non-empty
 *     `finalChecks` array OR a per-turn assertion the executor actually runs
 *     (`assertResponse` / `responseIncludesAny` / `responseIncludesAll` /
 *     `responseJudge` / `assertTurn`). The `plannerIncludes*` / `plannerExcludes`
 *     fields are deliberately NOT counted: the executor does not consume them
 *     (they are dead assertion fields — tracked separately).
 *  2. `personalityExpect` scenarios must run `live-only`. Their behaviour
 *     (silence / held-style / trait-respected …) can only be exercised by a
 *     real model — the deterministic proxy always emits a reply, so the
 *     personality judge can never pass under the proxy. They are not valid
 *     deterministic PR coverage and must not claim the pr-deterministic lane.
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

function walkScenarioFiles(dir: string): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith("_")) continue; // loader ignores `_`-prefixed entries
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walkScenarioFiles(full));
    } else if (entry.endsWith(".scenario.ts")) {
      out.push(full);
    }
  }
  return out;
}

interface ScenarioFacts {
  file: string;
  lane: string;
  hasFinalChecks: boolean;
  hasPerTurnAssert: boolean;
  hasPersonalityExpect: boolean;
  hasDeadPlannerAssert: boolean;
  hasMessageAsGmailLabelExpectation: boolean;
}

// plannerIncludesAll / plannerIncludesAny / plannerExcludes are not in the
// runner schema and are consumed by nothing in the repo — scenarios that use
// them have silently-ignored "assertions". Tracked in #9310.
const DEAD_PLANNER_ASSERT =
  /\b(plannerIncludesAll|plannerIncludesAny|plannerExcludes)\s*:/;

const PER_TURN_ASSERT =
  /\b(assertResponse|responseIncludesAny|responseIncludesAll|responseJudge|assertTurn)\b/;
const MESSAGE_AS_GMAIL_LABEL_EXPECTATION =
  /\b(?:addLabelIds|removeLabelIds)\s*:\s*["']MESSAGE["']/;
// A non-empty finalChecks array: `finalChecks: [` followed by a non-`]`,
// non-whitespace char. `finalChecks: []` does not match.
const NON_EMPTY_FINAL_CHECKS = /finalChecks\s*:\s*\[\s*[^\]\s]/;

function analyze(file: string): ScenarioFacts {
  const src = readFileSync(file, "utf8");
  const laneMatch = src.match(/\blane:\s*"([^"]+)"/);
  return {
    file,
    lane: laneMatch ? laneMatch[1] : "live-only", // schema default is live-only
    hasFinalChecks: NON_EMPTY_FINAL_CHECKS.test(src),
    hasPerTurnAssert: PER_TURN_ASSERT.test(src),
    hasPersonalityExpect: /\bpersonalityExpect\s*:/.test(src),
    hasDeadPlannerAssert: DEAD_PLANNER_ASSERT.test(src),
    hasMessageAsGmailLabelExpectation:
      MESSAGE_AS_GMAIL_LABEL_EXPECTATION.test(src),
  };
}

const facts: ScenarioFacts[] =
  SCENARIO_ROOTS.flatMap(walkScenarioFiles).map(analyze);
const rel = (f: ScenarioFacts) => relative(repoRoot, f.file);

describe("scenario corpus assertion guard", () => {
  it("scans a meaningful number of scenario files", () => {
    // Guards against a path/glob regression silently scanning nothing.
    expect(facts.length).toBeGreaterThan(500);
  });

  it("no pr-deterministic scenario lacks an enforceable assertion", () => {
    const offenders = facts
      .filter(
        (f) =>
          f.lane === "pr-deterministic" &&
          !f.hasFinalChecks &&
          !f.hasPerTurnAssert,
      )
      .map(rel)
      .sort();
    expect(offenders).toEqual([]);
  });

  it("personalityExpect scenarios run live-only (cannot be judged under the deterministic proxy)", () => {
    const misLaned = facts
      .filter((f) => f.hasPersonalityExpect && f.lane !== "live-only")
      .map(rel)
      .sort();
    expect(misLaned).toEqual([]);
  });

  it('does not use action name "MESSAGE" as a Gmail label expectation', () => {
    const offenders = facts
      .filter((f) => f.hasMessageAsGmailLabelExpectation)
      .map(rel)
      .sort();
    expect(offenders).toEqual([]);
  });

  // Ratchet against the dead plannerIncludes*/plannerExcludes fields. They are
  // unenforced (#9310); this only prevents the count from growing while the
  // backlog is migrated to enforced assertions (or the executor is taught to
  // consume them). Lower this as scenarios are fixed; never raise it.
  it("does not grow unenforced plannerIncludes*/plannerExcludes usage beyond 153", () => {
    const DEAD_PLANNER_BASELINE = 153;
    const users = facts
      .filter((f) => f.hasDeadPlannerAssert)
      .map(rel)
      .sort();
    if (users.length > DEAD_PLANNER_BASELINE) {
      throw new Error(
        `unenforced planner-assertion scenarios grew to ${users.length} ` +
          `(baseline ${DEAD_PLANNER_BASELINE}). plannerIncludesAll/Any/Excludes are ` +
          `silently ignored by the executor — assert via finalChecks or an enforced ` +
          `per-turn field instead. New offenders:\n${users.slice(DEAD_PLANNER_BASELINE).join("\n")}`,
      );
    }
    expect(users.length).toBeLessThanOrEqual(DEAD_PLANNER_BASELINE);
  });
});
