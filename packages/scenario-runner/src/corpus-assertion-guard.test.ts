/**
 * Validates assertion semantics for discovered scenario definitions. Every
 * deterministic scenario must contain an assertion the executor enforces,
 * personality judging stays live-only, and ignored assertion spellings or
 * ambiguous duplicate identity fields are rejected. The scan applies to the
 * current corpus without imposing a scenario count or ID inventory.
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
].map((root) => resolve(repoRoot, root));

function walkScenarioFiles(dir: string): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith("_")) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...walkScenarioFiles(full));
    } else if (entry.endsWith(".scenario.ts")) {
      files.push(full);
    }
  }
  return files;
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
// Turn-level keys the executor silently ignores, mapped to the assertion that
// actually runs. Only DIRECT keys of a turn object count — the same names are
// legitimate option names inside helper calls like expectTurnToCallAction().
const DEAD_TURN_ASSERTION_FIELD_FIXES = {
  acceptedActions: "expectedActions",
  includesAny: "responseIncludesAny",
  waitForDefinitionTitle: "finalChecks/custom predicate",
  waitForDefinitionTitleAliases: "finalChecks/custom predicate",
} as const;
const PER_TURN_ASSERT =
  /\b(assertResponse|expectedActions|responseIncludesAny|responseIncludesAll|responseExcludes|forbiddenActions|plannerIncludesAll|plannerIncludesAny|plannerExcludes|responseJudge|assertTurn)\b/;
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
  const source = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    source,
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
    lane: laneValues.at(-1) ?? "live-only",
    hasFinalChecks: NON_EMPTY_FINAL_CHECKS.test(source),
    hasPerTurnAssert: PER_TURN_ASSERT.test(source),
    hasPersonalityExpect: /\bpersonalityExpect\s*:/.test(source),
    hasExpectedActionParams: DEAD_EXPECTED_ACTION_PARAMS.test(source),
    hasMessageAsGmailLabelExpectation:
      MESSAGE_AS_GMAIL_LABEL_EXPECTATION.test(source),
    deadTurnAssertionFields: Object.keys(
      DEAD_TURN_ASSERTION_FIELD_FIXES,
    ).filter((field) => directTurnKeys.has(field)),
    duplicateTopLevelFields: duplicateTopLevelFields(scenarioObject, [
      "id",
      "lane",
    ]),
  };
}

const facts = SCENARIO_ROOTS.flatMap(walkScenarioFiles).map(analyze);
const relativeFile = (fact: ScenarioFacts) => relative(repoRoot, fact.file);

describe("scenario corpus assertion integrity", () => {
  it("does not declare duplicate top-level scenario id or lane fields", () => {
    const offenders = facts
      .filter((fact) => fact.duplicateTopLevelFields.length > 0)
      .map(
        (fact) =>
          `${relativeFile(fact)} (${fact.duplicateTopLevelFields.join(", ")})`,
      )
      .sort();
    expect(offenders).toEqual([]);
  });

  it("requires enforceable assertions in deterministic scenarios", () => {
    const offenders = facts
      .filter(
        (fact) =>
          fact.lane === "pr-deterministic" &&
          !fact.hasFinalChecks &&
          !fact.hasPerTurnAssert,
      )
      .map(relativeFile)
      .sort();
    expect(offenders).toEqual([]);
  });

  it("keeps personality judging in the live-only lane", () => {
    const offenders = facts
      .filter((fact) => fact.hasPersonalityExpect && fact.lane !== "live-only")
      .map(relativeFile)
      .sort();
    expect(offenders).toEqual([]);
  });

  it("does not use ignored expectedActionParams turn assertions", () => {
    const offenders = facts
      .filter((fact) => fact.hasExpectedActionParams)
      .map(relativeFile)
      .sort();
    expect(offenders).toEqual([]);
  });

  it('does not use action name "MESSAGE" as a Gmail label expectation', () => {
    const offenders = facts
      .filter((fact) => fact.hasMessageAsGmailLabelExpectation)
      .map(relativeFile)
      .sort();
    expect(offenders).toEqual([]);
  });

  it("rejects turn assertion spellings the executor ignores", () => {
    const offenders = facts
      .filter((fact) => fact.deadTurnAssertionFields.length > 0)
      .map(
        (fact) =>
          `${relativeFile(fact)} (${fact.deadTurnAssertionFields
            .map(
              (field) =>
                `${field} -> ${
                  DEAD_TURN_ASSERTION_FIELD_FIXES[
                    field as keyof typeof DEAD_TURN_ASSERTION_FIELD_FIXES
                  ]
                }`,
            )
            .join(", ")})`,
      )
      .sort();
    expect(offenders).toEqual([]);
  });

  it("recognizes planner matchers as enforceable turn assertions", () => {
    expect(PER_TURN_ASSERT.test('plannerIncludesAll: ["CALENDAR"]')).toBe(true);
    expect(PER_TURN_ASSERT.test('plannerIncludesAny: ["INBOX"]')).toBe(true);
    expect(PER_TURN_ASSERT.test('plannerExcludes: ["DELETE"]')).toBe(true);
  });
});
