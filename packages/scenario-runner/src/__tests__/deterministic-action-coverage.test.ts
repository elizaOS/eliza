/**
 * Baseline-free integrity checks for the deterministic scenario PR lane.
 *
 * This file is named explicitly by `.github/workflows/scenario-pr.yml`. Keep
 * these assertions derived from the real scenario corpus: historical counts,
 * allowlists, and coverage floors turn repository debt into false confidence.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { discoverScenarios, listScenarioMetadata } from "../loader";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../../../..");
const packageDir = resolve(repoRoot, "packages/scenario-runner");
const scenarioDir = resolve(packageDir, "test/scenarios");
const workflowPath = resolve(repoRoot, ".github/workflows/scenario-pr.yml");

const CALLBACK_ASSERTION_KEYS = new Set(["assertResponse", "assertTurn"]);
const MATCHER_ARRAY_ASSERTION_KEYS = new Set([
  "expectedActions",
  "forbiddenActions",
  "plannerExcludes",
  "plannerIncludesAll",
  "plannerIncludesAny",
  "responseExcludes",
  "responseIncludesAll",
  "responseIncludesAny",
]);

function scenarioFileId(file: string): string {
  return basename(file).replace(/\.scenario\.ts$/, "");
}

function propertyName(property: ts.ObjectLiteralElementLike): string | null {
  if (!property.name) return null;
  if (
    ts.isIdentifier(property.name) ||
    ts.isStringLiteral(property.name) ||
    ts.isNumericLiteral(property.name)
  ) {
    return property.name.text;
  }
  return null;
}

function propertyValue(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | null {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) || propertyName(property) !== name) {
      continue;
    }
    return unwrapExpression(property.initializer);
  }
  return null;
}

function unwrapExpression(value: ts.Expression): ts.Expression {
  while (
    ts.isAsExpression(value) ||
    ts.isParenthesizedExpression(value) ||
    ts.isSatisfiesExpression(value)
  ) {
    value = value.expression;
  }
  return value;
}

function isStaticallyNullish(value: ts.Expression): boolean {
  return (
    (ts.isIdentifier(value) && value.text === "undefined") ||
    value.kind === ts.SyntaxKind.NullKeyword ||
    ts.isVoidExpression(value)
  );
}

function couldBeCallable(value: ts.Expression): boolean {
  if (isStaticallyNullish(value)) return false;
  return !(
    ts.isArrayLiteralExpression(value) ||
    ts.isObjectLiteralExpression(value) ||
    ts.isStringLiteralLike(value) ||
    ts.isNumericLiteral(value) ||
    ts.isRegularExpressionLiteral(value) ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword
  );
}

function couldBeMatcher(value: ts.Expression): boolean {
  if (isStaticallyNullish(value)) return false;
  if (ts.isStringLiteralLike(value)) return value.text.trim().length > 0;
  return !(
    ts.isArrayLiteralExpression(value) ||
    ts.isObjectLiteralExpression(value) ||
    ts.isNumericLiteral(value) ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword
  );
}

function hasEffectiveMatcher(array: ts.ArrayLiteralExpression): boolean {
  return array.elements.some((element) => {
    if (ts.isOmittedExpression(element)) return false;
    if (ts.isSpreadElement(element)) {
      const spread = unwrapExpression(element.expression);
      return (
        !ts.isArrayLiteralExpression(spread) || hasEffectiveMatcher(spread)
      );
    }
    return couldBeMatcher(unwrapExpression(element));
  });
}

function hasMeaningfulAssertionProperty(
  property: ts.ObjectLiteralElementLike,
): boolean {
  const name = propertyName(property);
  if (name === null) return false;
  if (CALLBACK_ASSERTION_KEYS.has(name)) {
    if (ts.isMethodDeclaration(property)) return true;
    if (ts.isShorthandPropertyAssignment(property)) return true;
    return (
      ts.isPropertyAssignment(property) &&
      couldBeCallable(unwrapExpression(property.initializer))
    );
  }
  if (MATCHER_ARRAY_ASSERTION_KEYS.has(name)) {
    if (ts.isShorthandPropertyAssignment(property)) return true;
    if (!ts.isPropertyAssignment(property)) return false;
    const value = unwrapExpression(property.initializer);
    if (isStaticallyNullish(value)) return false;
    return !ts.isArrayLiteralExpression(value) || hasEffectiveMatcher(value);
  }
  if (name !== "responseJudge") return false;
  if (ts.isShorthandPropertyAssignment(property)) return true;
  if (!ts.isPropertyAssignment(property)) return false;
  const value = unwrapExpression(property.initializer);
  if (isStaticallyNullish(value)) return false;
  if (!ts.isObjectLiteralExpression(value)) return true;
  const rubric = propertyValue(value, "rubric");
  if (rubric === null || isStaticallyNullish(rubric)) return false;
  const literalRubric = stringValue(rubric);
  return literalRubric === null || literalRubric.trim().length > 0;
}

function stringValue(value: ts.Expression | null): string | null {
  return value &&
    (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))
    ? value.text
    : null;
}

function hasDirectActionAssertion(object: ts.ObjectLiteralExpression): boolean {
  if (stringValue(propertyValue(object, "expectedValidation")) === "rejected") {
    return true;
  }
  return object.properties.some(hasMeaningfulAssertionProperty);
}

function directActionHasAssertion(source: string): boolean {
  const sourceFile = ts.createSourceFile(
    "assertion-probe.ts",
    `const turn = (${source});`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let action: ts.ObjectLiteralExpression | null = null;
  function visit(node: ts.Node): void {
    if (action === null && ts.isObjectLiteralExpression(node)) action = node;
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  if (action === null)
    throw new Error("assertion probe did not contain an object");
  return hasDirectActionAssertion(action);
}

describe("deterministic scenario action coverage", () => {
  it("keeps every explicitly targeted Scenario E2E test file present", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    const commandPrefix =
      "run: bun run --cwd packages/scenario-runner test:unit -- ";
    const explicitTargets = workflow
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith(commandPrefix))
      .flatMap((line) => line.slice(commandPrefix.length).trim().split(/\s+/))
      .filter((target) => target.endsWith(".test.ts"));

    expect(explicitTargets).toContain(
      "src/__tests__/deterministic-action-coverage.test.ts",
    );
    expect(
      explicitTargets.filter(
        (target) => !existsSync(resolve(packageDir, target)),
      ),
      "Scenario E2E names test files that do not exist; Vitest can silently ignore missing explicit targets",
    ).toEqual([]);
  });

  it("requires every package-local scenario to declare its CI lane and match its file name", async () => {
    const metadata = await listScenarioMetadata(
      scenarioDir,
      undefined,
      undefined,
      false,
    );
    const problems: string[] = [];
    const seenIds = new Set<string>();

    for (const scenario of metadata) {
      const fileId = scenarioFileId(scenario.file);
      if (scenario.id !== fileId) {
        problems.push(
          `${scenario.file}: id ${JSON.stringify(scenario.id)} does not match file name ${JSON.stringify(fileId)}`,
        );
      }
      if (
        scenario.lane !== "pr-deterministic" &&
        scenario.lane !== "live-only"
      ) {
        problems.push(
          `${scenario.file}: declare lane as "pr-deterministic" or "live-only"`,
        );
      }
      if (seenIds.has(scenario.id)) {
        problems.push(`${scenario.file}: duplicate scenario id ${scenario.id}`);
      }
      seenIds.add(scenario.id);
    }

    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("rejects assertion-shaped properties that are runtime no-ops", () => {
    expect(
      [
        `{ kind: "action", actionName: "X", expectedActions: [] }`,
        `{ kind: "action", actionName: "X", responseExcludes: [] }`,
        `{ kind: "action", actionName: "X", assertTurn: undefined }`,
        `{ kind: "action", actionName: "X", assertResponse: null }`,
        `{ kind: "action", actionName: "X", plannerIncludesAny: [undefined] }`,
        `{ kind: "action", actionName: "X", responseJudge: { rubric: "" } }`,
      ].map(directActionHasAssertion),
    ).toEqual([false, false, false, false, false, false]);

    expect(
      [
        `{ kind: "action", actionName: "X", expectedActions: ["X"] }`,
        `{ kind: "action", actionName: "X", responseExcludes: [/failure/i] }`,
        `{ kind: "action", actionName: "X", assertTurn() {} }`,
        `{ kind: "action", actionName: "X", assertTurn: makeAssertion() }`,
        `{ kind: "action", actionName: "X", responseJudge: { rubric: "verify X" } }`,
      ].map(directActionHasAssertion),
    ).toEqual([true, true, true, true, true]);
  });

  it("requires every deterministic direct-action turn to carry assertion evidence", async () => {
    const deterministicFiles = new Set(
      (
        await listScenarioMetadata(
          scenarioDir,
          undefined,
          undefined,
          false,
          "pr-deterministic",
        )
      ).map((scenario) => scenario.file),
    );
    const unasserted: string[] = [];

    for (const file of await discoverScenarios(scenarioDir)) {
      if (!deterministicFiles.has(file)) continue;
      const source = readFileSync(file, "utf8");
      const sourceFile = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );

      function visit(node: ts.Node): void {
        if (
          ts.isObjectLiteralExpression(node) &&
          stringValue(propertyValue(node, "kind")) === "action" &&
          !hasDirectActionAssertion(node)
        ) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(
            node.getStart(sourceFile),
          );
          unasserted.push(
            `${relative(repoRoot, file)}:${line + 1}: direct action turn has no assertion`,
          );
        }
        ts.forEachChild(node, visit);
      }

      visit(sourceFile);
    }

    expect(
      unasserted,
      `direct action turns must assert their result instead of merely executing:\n${unasserted.join("\n")}`,
    ).toEqual([]);
  });
});
