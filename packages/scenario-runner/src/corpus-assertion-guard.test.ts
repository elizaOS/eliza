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
  id: string;
  lane: string;
  hasFinalChecks: boolean;
  hasPerTurnAssert: boolean;
  hasPersonalityExpect: boolean;
  hasExpectedActionParams: boolean;
  hasMessageAsGmailLabelExpectation: boolean;
  deadTurnAssertionFields: string[];
  duplicateTopLevelFields: string[];
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

function scenarioObjectFromExpression(
  expression: ts.Expression,
): ts.ObjectLiteralExpression | null {
  if (ts.isObjectLiteralExpression(expression)) {
    return expression;
  }
  if (ts.isCallExpression(expression)) {
    const [firstArg] = expression.arguments;
    if (firstArg && ts.isObjectLiteralExpression(firstArg)) {
      return firstArg;
    }
  }
  return null;
}

function findExportedScenarioObject(
  sourceFile: ts.SourceFile,
): ts.ObjectLiteralExpression | null {
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      const objectLiteral = scenarioObjectFromExpression(statement.expression);
      if (objectLiteral) return objectLiteral;
    }

    if (!ts.isVariableStatement(statement)) continue;
    const isExported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (!isExported) continue;

    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      if (declaration.name.text !== "scenario") continue;
      if (!declaration.initializer) continue;
      const objectLiteral = scenarioObjectFromExpression(
        declaration.initializer,
      );
      if (objectLiteral) return objectLiteral;
    }
  }

  return null;
}

function getStaticStringPropertyValues(
  objectLiteral: ts.ObjectLiteralExpression | null,
  propertyName: string,
): string[] {
  if (!objectLiteral) return [];
  const values: string[] = [];
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = propertyNameText(property.name);
    if (name !== propertyName) continue;
    const initializer = property.initializer;
    if (
      ts.isStringLiteral(initializer) ||
      ts.isNoSubstitutionTemplateLiteral(initializer)
    ) {
      values.push(initializer.text);
    }
  }
  return values;
}

function duplicateTopLevelFields(
  objectLiteral: ts.ObjectLiteralExpression | null,
  fields: ReadonlyArray<string>,
): string[] {
  if (!objectLiteral) return [];
  const counts = new Map<string, number>();
  for (const property of objectLiteral.properties) {
    if (
      !ts.isPropertyAssignment(property) &&
      !ts.isMethodDeclaration(property) &&
      !ts.isShorthandPropertyAssignment(property)
    ) {
      continue;
    }
    const name = propertyNameText(property.name);
    if (!name || !fields.includes(name)) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return fields.filter((field) => (counts.get(field) ?? 0) > 1);
}

function collectDirectTurnKeys(sourceFile: ts.SourceFile): Set<string> {
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
  const sourceFile = ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const scenarioObject = findExportedScenarioObject(sourceFile);
  const directTurnKeys = collectDirectTurnKeys(sourceFile);
  const idValues = getStaticStringPropertyValues(scenarioObject, "id");
  const laneValues = getStaticStringPropertyValues(scenarioObject, "lane");
  return {
    file,
    id: idValues.at(-1) ?? "",
    lane: laneValues.at(-1) ?? "live-only", // schema default is live-only
    hasFinalChecks: NON_EMPTY_FINAL_CHECKS.test(src),
    hasPerTurnAssert: PER_TURN_ASSERT.test(src),
    hasPersonalityExpect: /\bpersonalityExpect\s*:/.test(src),
    hasExpectedActionParams: DEAD_EXPECTED_ACTION_PARAMS.test(src),
    hasMessageAsGmailLabelExpectation:
      MESSAGE_AS_GMAIL_LABEL_EXPECTATION.test(src),
    deadTurnAssertionFields: Object.keys(
      DEAD_TURN_ASSERTION_FIELD_FIXES,
    ).filter((field) => directTurnKeys.has(field)),
    duplicateTopLevelFields: duplicateTopLevelFields(scenarioObject, [
      "id",
      "lane",
    ]),
  };
}

const facts: ScenarioFacts[] =
  SCENARIO_ROOTS.flatMap(walkScenarioFiles).map(analyze);
const rel = (f: ScenarioFacts) => relative(repoRoot, f.file);
const EXPECTED_PR_DETERMINISTIC_SCENARIO_IDS = [
  // LifeOps persona pack A1 (adhd-capture-and-start, #12769). Convention (G1):
  // pr-deterministic persona scenarios live in
  // plugins/plugin-personal-assistant/test/scenarios — the one root scanned by
  // BOTH this guard AND check-lifeops-persona-catalog-coverage.mjs — and are
  // added here in the same commit so this toEqual stays green while the coverage
  // ledger can still resolve their ids.
  "adhd-distractor-storm-mid-capture",
  "adhd-hyperfocus-guardrail-protects-standup",
  "agent-orchestrator.list-agents",
  "ainex.stand",
  "anthropic-proxy.proxy-status",
  "benchmarks.osworld-action",
  "commands.help-command",
  "computeruse.get-cursor-position",
  "convo.echo-self-test",
  "convo.greeting-dynamic",
  "facewear.smartglasses-status",
  "finances.owner-finances-dashboard",
  "form.restore-stashed",
  "goals.owner-goals-create",
  "health.owner-health-status",
  "hyperliquid.perpetual-market-status",
  "inbox.summarize-inboxes",
  "linear.search-issues",
  "local-inference.start-transcription",
  "music.routing-status",
  "nostr.search-posts",
  "orchestrator-device-modality-reach",
  "orchestrator-evidence-bundle",
  "orchestrator-grilling-happy-path",
  "orchestrator-multi-task-supervisor",
  "orchestrator-reflexion-respawn",
  "orchestrator-view-cloud-deploy",
  "orchestrator-watchdog-stall",
  "persona.flexible-scheduling",
  "relationships.list-entities",
  "reminder.cross-platform.acknowledged-syncs",
  "reminder.cross-platform.fires-on-mac-and-phone",
  "reminder.escalation.intensity-up",
  "reminder.escalation.silent-dismiss",
  "remote-desktop.list-sessions",
  "shopify.list-products",
  "suno.generate-music",
  "task-coordinator.orchestrator-status",
  "tunnel.status",
  "vision.set-mode",
  "wallet.token-info",
].sort();

describe("scenario corpus assertion guard", () => {
  it("scans a meaningful number of scenario files", () => {
    // Guards against a path/glob regression silently scanning nothing.
    expect(facts.length).toBeGreaterThan(500);
  });

  it("does not declare duplicate top-level scenario id or lane fields", () => {
    const offenders = facts
      .filter((f) => f.duplicateTopLevelFields.length > 0)
      .map((f) => `${rel(f)} (${f.duplicateTopLevelFields.join(", ")})`)
      .sort();
    expect(offenders).toEqual([]);
  });

  it("tracks the current external pr-deterministic corpus explicitly", () => {
    const ids = facts
      .filter((f) => f.lane === "pr-deterministic")
      .map((f) => f.id)
      .sort();
    expect(ids).toEqual(EXPECTED_PR_DETERMINISTIC_SCENARIO_IDS);
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
      acceptedActions: 0,
      includesAny: 0,
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
