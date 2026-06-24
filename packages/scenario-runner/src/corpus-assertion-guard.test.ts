/**
 * Corpus assertion guard.
 *
 * The scenario-runner runs a scenario's turns and only fails when an assertion
 * fails. A scenario with no enforceable assertion therefore passes vacuously -
 * it proves nothing while counting as green coverage. This guard makes that
 * failure mode impossible to (re)introduce.
 *
 * Two invariants enforced here:
 *  1. No `pr-deterministic` scenario may lack an enforceable assertion. The
 *     pr-deterministic lane is the merge-blocking PR gate; a vacuous scenario
 *     there is false confidence on every PR. "Enforceable" means a non-empty
 *     `finalChecks` array OR a per-turn assertion the executor actually runs
 *     (`assertResponse` / `expectedActions` / `responseIncludesAny` /
 *     `responseIncludesAll` / `responseExcludes` / `forbiddenActions` /
 *     `plannerIncludesAll` / `plannerIncludesAny` / `plannerExcludes` /
 *     `responseJudge` / `assertTurn`).
 *  2. `personalityExpect` scenarios must run `live-only`. Their behaviour
 *     (silence / held-style / trait-respected ...) can only be exercised by a
 *     real model - the deterministic proxy always emits a reply, so the
 *     personality judge can never pass under the proxy. They are not valid
 *     deterministic PR coverage and must not claim the pr-deterministic lane.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import * as ts from "typescript";
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
  hasExpectedActionParams: boolean;
  hasMessageAsGmailLabelExpectation: boolean;
  deadTurnAssertionFields: string[];
}

const DEAD_EXPECTED_ACTION_PARAMS = /\bexpectedActionParams\s*:/;
const MESSAGE_AS_GMAIL_LABEL_EXPECTATION =
  /\b(?:addLabelIds|removeLabelIds)\s*:\s*(?:(["'])MESSAGE\1|\[[^\]]*(["'])MESSAGE\2[^\]]*\])/;
const DEAD_TURN_ASSERTION_FIELD_FIXES = {
  acceptedActions: "expectedActions",
  includesAny: "responseIncludesAny",
  waitForDefinitionTitle: "finalChecks/custom predicate",
  waitForDefinitionTitleAliases: "finalChecks/custom predicate",
} as const;

const PER_TURN_ASSERT =
  /\b(assertResponse|expectedActions|responseIncludesAny|responseIncludesAll|responseExcludes|forbiddenActions|plannerIncludesAll|plannerIncludesAny|plannerExcludes|responseJudge|assertTurn)\b/;
// A non-empty finalChecks array: `finalChecks: [` followed by a non-`]`,
// non-whitespace char. `finalChecks: []` does not match.
const NON_EMPTY_FINAL_CHECKS = /finalChecks\s*:\s*\[\s*[^\]\s]/;

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return undefined;
}

function collectDirectTurnKeys(src: string, file: string): Set<string> {
  const sourceFile = ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const keys = new Set<string>();

  function visit(node: ts.Node) {
    if (
      ts.isPropertyAssignment(node) &&
      propertyNameText(node.name) === "turns" &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      for (const element of node.initializer.elements) {
        if (!ts.isObjectLiteralExpression(element)) continue;
        for (const prop of element.properties) {
          if (
            ts.isPropertyAssignment(prop) ||
            ts.isMethodDeclaration(prop) ||
            ts.isShorthandPropertyAssignment(prop)
          ) {
            const key = propertyNameText(prop.name);
            if (key) keys.add(key);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return keys;
}

function analyze(file: string): ScenarioFacts {
  const src = readFileSync(file, "utf8");
  const laneMatch = src.match(/\blane:\s*"([^"]+)"/);
  const directTurnKeys = collectDirectTurnKeys(src, file);
  return {
    file,
    lane: laneMatch ? laneMatch[1] : "live-only", // schema default is live-only
    hasFinalChecks: NON_EMPTY_FINAL_CHECKS.test(src),
    hasPerTurnAssert: PER_TURN_ASSERT.test(src),
    hasPersonalityExpect: /\bpersonalityExpect\s*:/.test(src),
    hasExpectedActionParams: DEAD_EXPECTED_ACTION_PARAMS.test(src),
    hasMessageAsGmailLabelExpectation:
      MESSAGE_AS_GMAIL_LABEL_EXPECTATION.test(src),
    deadTurnAssertionFields: Object.keys(
      DEAD_TURN_ASSERTION_FIELD_FIXES,
    ).filter((field) => directTurnKeys.has(field)),
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

  it("does not use dead expectedActionParams turn assertions", () => {
    const offenders = facts
      .filter((f) => f.hasExpectedActionParams)
      .map(rel)
      .sort();
    expect(offenders).toEqual([]);
  });

  it('does not use action name "MESSAGE" as a Gmail label expectation', () => {
    const offenders = facts
      .filter((f) => f.hasMessageAsGmailLabelExpectation)
      .map(rel)
      .sort();
    expect(offenders).toEqual([]);
  });

  it("does not grow unenforced turn assertion typo fields", () => {
    const DEAD_TURN_ASSERTION_BASELINE = {
      acceptedActions: 31,
      includesAny: 31,
      waitForDefinitionTitle: 1,
      waitForDefinitionTitleAliases: 1,
    } as const satisfies Record<
      keyof typeof DEAD_TURN_ASSERTION_FIELD_FIXES,
      number
    >;

    for (const [field, replacement] of Object.entries(
      DEAD_TURN_ASSERTION_FIELD_FIXES,
    )) {
      const users = facts
        .filter((f) => f.deadTurnAssertionFields.includes(field))
        .map(rel)
        .sort();
      const baseline =
        DEAD_TURN_ASSERTION_BASELINE[
          field as keyof typeof DEAD_TURN_ASSERTION_BASELINE
        ];
      if (users.length > baseline) {
        throw new Error(
          `unenforced turn assertion field ${field} grew to ${users.length} ` +
            `(baseline ${baseline}). The executor ignores turn-level ${field}; ` +
            `use ${replacement} or a real finalCheck instead. New offenders:\n` +
            users.slice(baseline).join("\n"),
        );
      }
      expect(users.length).toBeLessThanOrEqual(baseline);
    }
  });

  it("counts planner matchers as enforceable per-turn assertions", () => {
    const plannerAsserted = facts.filter((f) =>
      /\b(plannerIncludesAll|plannerIncludesAny|plannerExcludes)\s*:/.test(
        readFileSync(f.file, "utf8"),
      ),
    );
    expect(plannerAsserted.length).toBeGreaterThan(0);
    expect(plannerAsserted.every((f) => f.hasPerTurnAssert)).toBe(true);
  });
});
