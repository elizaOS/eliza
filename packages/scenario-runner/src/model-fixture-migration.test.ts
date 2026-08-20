/** Ratchets actual deterministic scenario declarations from legacy resolution to manifests. */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
// Keep the ratchet aligned with the current develop corpus. New deterministic
// scenarios still fail this test unless the baseline is reviewed explicitly.
const MAX_LEGACY_PR_DETERMINISTIC_SCENARIOS = 118;

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
  const declared = declaration.properties.some(
    (property) => propertyName(property) === "modelFixtures",
  );
  return { deterministic, declared };
}

function scenarioFiles(): string[] {
  const output = execFileSync("rg", ["--files", "-g", "*.scenario.ts"], {
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
    }).toEqual({ strictOrModelFree: 0, legacy: 118, total: 118 });
  });

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
  });
});
