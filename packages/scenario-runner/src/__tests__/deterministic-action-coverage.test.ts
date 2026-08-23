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

const ACTION_ASSERTION_KEYS = new Set([
  "assertResponse",
  "assertTurn",
  "expectedActions",
  "forbiddenActions",
  "plannerExcludes",
  "plannerIncludesAll",
  "plannerIncludesAny",
  "responseExcludes",
  "responseIncludesAll",
  "responseIncludesAny",
  "responseJudge",
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
    let value = property.initializer;
    while (
      ts.isAsExpression(value) ||
      ts.isParenthesizedExpression(value) ||
      ts.isSatisfiesExpression(value)
    ) {
      value = value.expression;
    }
    return value;
  }
  return null;
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
  return object.properties.some((property) => {
    const name = propertyName(property);
    return name !== null && ACTION_ASSERTION_KEYS.has(name);
  });
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
