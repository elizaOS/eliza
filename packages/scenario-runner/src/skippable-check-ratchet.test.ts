/**
 * Skippable-dependency ratchet (#9310, systemic theme 7).
 *
 * A handful of finalChecks return a PASSING `skipped-dependency-missing` when
 * their capture context is absent (the service that would have recorded the
 * evidence was never registered), rather than failing. Verified against
 * `final-checks/index.ts`, exactly two check types do this:
 *   - `approvalRequestExists`  (skips when `ctx.approvalRequests === undefined`)
 *   - `pushSent`               (skips when the push capture is undefined)
 * (`connectorDispatchOccurred` does NOT — it treats a missing capture as empty
 * and fails, so it is a real effect check and is intentionally excluded here.)
 *
 * A scenario whose ENTIRE `finalChecks` array is those skippable types proves
 * nothing in an environment where the dependency isn't wired: it silently
 * passes. Like the echo and action-effect ratchets, this is a guard — the count
 * may only go DOWN. A scenario needs a non-skippable check (a `custom` predicate,
 * memory/state read, etc.) alongside so it can actually fail for the real reason.
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

/** The check types that return a PASSING `skipped-dependency-missing`. */
const SKIPPABLE = new Set(["approvalRequestExists", "pushSent"]);

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
    if (statSync(full).isDirectory()) out.push(...walkScenarioFiles(full));
    else if (entry.endsWith(".scenario.ts")) out.push(full);
  }
  return out;
}

function propName(name: ts.PropertyName): string | undefined {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return undefined;
}

/** The `type` strings of the scenario's top-level `finalChecks: [...]` array. */
function finalCheckTypes(sourceFile: ts.SourceFile): string[] {
  const types: string[] = [];
  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (
      ts.isPropertyAssignment(node) &&
      propName(node.name) === "finalChecks" &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      found = true;
      for (const el of node.initializer.elements) {
        if (!ts.isObjectLiteralExpression(el)) continue;
        for (const prop of el.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          if (propName(prop.name) !== "type") continue;
          if (ts.isStringLiteral(prop.initializer)) types.push(prop.initializer.text);
        }
      }
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return types;
}

/**
 * True only for `export default scenario({...})` — a DIRECT scenario whose
 * literal `finalChecks` is the complete set. Factory-built scenarios
 * (`export default buildXScenario({...})`) have their checks augmented inside
 * the factory (the connector-certification factory, for example, adds
 * `memoryWriteOccurred` + a `custom` predicate), so their file-local
 * `finalChecks` is only a fragment and must NOT be judged statically.
 */
function isDirectScenarioExport(sourceFile: ts.SourceFile): boolean {
  for (const statement of sourceFile.statements) {
    if (!ts.isExportAssignment(statement)) continue;
    const expr = statement.expression;
    if (
      ts.isCallExpression(expr) &&
      ts.isIdentifier(expr.expression) &&
      expr.expression.text === "scenario"
    ) {
      return true;
    }
  }
  return false;
}

function isEntirelySkippable(file: string): boolean {
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  // Only judge scenarios whose complete finalChecks are statically visible.
  if (!isDirectScenarioExport(sf)) return false;
  const types = finalCheckTypes(sf);
  if (types.length === 0) return false;
  return types.every((t) => SKIPPABLE.has(t));
}

const flagged = SCENARIO_ROOTS.flatMap(walkScenarioFiles)
  .filter(isEntirelySkippable)
  .map((f) => relative(repoRoot, f));

// Current debt (theme 7 of #9310). Lower this as such scenarios gain a
// non-skippable check that reads produced state. Never raise.
const BASELINE = 0;

describe("skippable-check ratchet (#9310)", () => {
  it("finds the scenario corpus (guard is actually scanning)", () => {
    const total = SCENARIO_ROOTS.flatMap(walkScenarioFiles).length;
    expect(total).toBeGreaterThan(400);
  });

  it(`does not grow entirely-skippable scenarios beyond ${BASELINE}`, () => {
    if (flagged.length > BASELINE) {
      throw new Error(
        `scenarios whose finalChecks are ALL silently-skippable (${[...SKIPPABLE].join("/")}) ` +
          `grew to ${flagged.length} (baseline ${BASELINE}). Such a scenario passes ` +
          `vacuously when the approval/push service isn't registered — add a check that ` +
          `reads produced state (a 'custom' predicate, memory/DB read). Offenders:\n` +
          flagged.slice(BASELINE).join("\n"),
      );
    }
    expect(flagged.length).toBeLessThanOrEqual(BASELINE);
  });
});
