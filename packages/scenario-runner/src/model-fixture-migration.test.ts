/** Ratchets actual deterministic scenario declarations from legacy resolution to manifests. */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MAX_LEGACY_PR_DETERMINISTIC_SCENARIOS = 73;

type ScenarioSourceClassification = {
  deterministic: boolean;
  declared: boolean;
};

function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isTypeAssertionExpression(expression)
  ) {
    return unwrapExpression(expression.expression);
  }
  return expression;
}

function propertyName(property: ts.ObjectLiteralElementLike): string | null {
  if (!property.name) return null;
  if (
    ts.isIdentifier(property.name) ||
    ts.isStringLiteralLike(property.name) ||
    ts.isNumericLiteral(property.name)
  ) {
    return property.name.text;
  }
  if (
    ts.isComputedPropertyName(property.name) &&
    ts.isStringLiteralLike(property.name.expression)
  ) {
    return property.name.expression.text;
  }
  return null;
}

function scenarioObjectFromExport(
  expression: ts.Expression,
): ts.ObjectLiteralExpression | null {
  const unwrapped = unwrapExpression(expression);
  if (ts.isObjectLiteralExpression(unwrapped)) return unwrapped;
  if (!ts.isCallExpression(unwrapped) || unwrapped.arguments.length === 0) {
    return null;
  }
  const firstArgument = unwrapExpression(unwrapped.arguments[0]);
  return ts.isObjectLiteralExpression(firstArgument) ? firstArgument : null;
}

function assignedProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | null {
  const property = object.properties.find(
    (candidate) => propertyName(candidate) === name,
  );
  return property && ts.isPropertyAssignment(property)
    ? unwrapExpression(property.initializer)
    : null;
}

function isStaticallyModelFree(
  declaration: ts.ObjectLiteralExpression,
): boolean {
  const turns = assignedProperty(declaration, "turns");
  if (!turns || !ts.isArrayLiteralExpression(turns)) return false;
  const onlyDirectTurns = turns.elements.every((element) => {
    const turn = unwrapExpression(element);
    if (!ts.isObjectLiteralExpression(turn)) return false;
    const kind = assignedProperty(turn, "kind");
    return (
      kind !== null &&
      ts.isStringLiteralLike(kind) &&
      (kind.text === "action" || kind.text === "api" || kind.text === "wait")
    );
  });
  if (!onlyDirectTurns) return false;

  const finalChecks = assignedProperty(declaration, "finalChecks");
  if (!finalChecks) return true;
  if (!ts.isArrayLiteralExpression(finalChecks)) return false;
  return finalChecks.elements.every((element) => {
    const check = unwrapExpression(element);
    if (!ts.isObjectLiteralExpression(check)) return false;
    const type = assignedProperty(check, "type");
    return !(
      type !== null &&
      ts.isStringLiteralLike(type) &&
      type.text === "judgeRubric"
    );
  });
}

function hasStrictDeclaration(
  declaration: ts.ObjectLiteralExpression,
): boolean {
  const modelFixtures = assignedProperty(declaration, "modelFixtures");
  if (!modelFixtures || !ts.isObjectLiteralExpression(modelFixtures)) {
    return false;
  }
  const mode = assignedProperty(modelFixtures, "mode");
  if (!mode || !ts.isStringLiteralLike(mode)) return false;
  if (mode.text === "fixtures") {
    const fixtures = assignedProperty(modelFixtures, "fixtures");
    return fixtures !== null && ts.isArrayLiteralExpression(fixtures);
  }
  const reason = assignedProperty(modelFixtures, "reason");
  return (
    mode.text === "model-free" &&
    reason !== null &&
    ts.isStringLiteralLike(reason) &&
    reason.text.trim().length > 0 &&
    isStaticallyModelFree(declaration)
  );
}

function classifyScenarioSource(
  sourceText: string,
  fileName = "fixture.scenario.ts",
): ScenarioSourceClassification {
  const source = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declaration = source.statements
    .filter(ts.isExportAssignment)
    .map((assignment) => scenarioObjectFromExport(assignment.expression))
    .find((candidate) => candidate !== null);
  if (!declaration) return { deterministic: false, declared: false };

  const lane = declaration.properties.find(
    (property) => propertyName(property) === "lane",
  );
  const laneValue =
    lane && ts.isPropertyAssignment(lane)
      ? unwrapExpression(lane.initializer)
      : null;
  const deterministic =
    laneValue !== null &&
    ts.isStringLiteralLike(laneValue) &&
    laneValue.text === "pr-deterministic";
  const declared = hasStrictDeclaration(declaration);
  return { deterministic, declared };
}

function scenarioFiles(): string[] {
  const output = execFileSync("git", ["ls-files", "--", "*.scenario.ts"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  return output ? output.split("\n") : [];
}

describe("scenario model fixture migration", () => {
  it("never increases the undeclared deterministic corpus", () => {
    const classifications = scenarioFiles().map((file) =>
      classifyScenarioSource(
        readFileSync(resolve(repoRoot, file), "utf8"),
        file,
      ),
    );
    const deterministic = classifications.filter(
      (entry) => entry.deterministic,
    );
    const legacy = deterministic.filter((entry) => !entry.declared);

    expect(legacy.length).toBeLessThanOrEqual(
      MAX_LEGACY_PR_DETERMINISTIC_SCENARIOS,
    );
    expect({
      strictOrModelFree: deterministic.length - legacy.length,
      legacy: legacy.length,
      total: deterministic.length,
    }).toEqual({ strictOrModelFree: 47, legacy: 73, total: 120 });
  }, 120_000);

  it("recognizes authored properties while ignoring comments and setup strings", () => {
    expect(
      classifyScenarioSource(`
        // modelFixtures: { mode: "fixtures" }
        const setup = "lane: \\"live-only\\"; modelFixtures: fake";
        export default scenario({
          lane: 'pr-deterministic',
          turns: [],
        });
      `),
    ).toEqual({ deterministic: true, declared: false });

    expect(
      classifyScenarioSource(`
        const setup = "lane: 'pr-deterministic'; modelFixtures: fake";
        export default scenario({
          lane: "live-only",
          modelFixtures: { mode: "fixtures", fixtures: [] },
          turns: [],
        });
      `),
    ).toEqual({ deterministic: false, declared: true });

    expect(
      classifyScenarioSource(`
        export default scenario({
          ["lane"]: \`pr-deterministic\`,
          "modelFixtures": { mode: "model-free", reason: "direct API" },
          turns: [],
        } satisfies ScenarioDefinition);
      `),
    ).toEqual({ deterministic: true, declared: true });

    expect(
      classifyScenarioSource(`
        export default scenario({
          lane: "pr-deterministic",
          modelFixtures: { mode: "model-free", reason: "not truthful" },
          turns: [{ kind: "message", text: "hello" }],
        });
      `),
    ).toEqual({ deterministic: true, declared: false });

    expect(
      classifyScenarioSource(`
        export default scenario({
          lane: "pr-deterministic",
          modelFixtures: { mode: "model-free", reason: "not truthful" },
          turns: [{ kind: "api", path: "/test" }],
          finalChecks: [{ type: "judgeRubric", rubric: "good" }],
        });
      `),
    ).toEqual({ deterministic: true, declared: false });

    expect(
      classifyScenarioSource(`
        export default scenario({
          lane: "pr-deterministic",
          modelFixtures: { mode: "model-free", reason: "direct action plus wait" },
          turns: [
            { kind: "action", name: "act" },
            { kind: "wait", name: "settle", durationMs: 1 },
          ],
        });
      `),
    ).toEqual({ deterministic: true, declared: true });
  });
});
