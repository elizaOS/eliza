/**
 * Action-effect ratchet (#9310, systemic theme 3).
 *
 * `actionCalled` (even `status:"success"`) only proves the handler RAN and
 * returned success — not that the correct todo/event/draft/state actually
 * resulted. "The LIFE action was called" ≠ "the todo was marked done". A
 * scenario whose ENTIRE `finalChecks` array is `actionCalled` entries proves a
 * call, never an effect, and so cannot fail for the real reason.
 *
 * The effect-proving finalCheck kinds are the ones that read produced state:
 * `custom` predicates, `memoryWriteOccurred`/`memoryContains`,
 * `connectorDispatchOccurred`, `walletBalance*`, `judgeRubric`, etc. A scenario
 * with at least one of those (or a real per-turn assertion) is fine.
 *
 * Rewriting the backlog is per-scenario work (add an effect finalCheck to each);
 * this guard is a RATCHET like echo-assertion-ratchet: the count may only go
 * DOWN. Adding a new actionCalled-only scenario turns this RED. When you give an
 * actionCalled-only scenario a real effect check, lower BASELINE to match.
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

/**
 * The `type` string values of every object in the scenario's top-level
 * `finalChecks: [...]` array, in order. Empty if there is no such array.
 */
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
          if (ts.isStringLiteral(prop.initializer))
            types.push(prop.initializer.text);
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
 * (`export default buildXScenario({...})`) augment their checks inside the
 * factory (e.g. the connector-certification factory adds `memoryWriteOccurred`
 * + a `custom` predicate), so their file-local `finalChecks` is only a fragment
 * and must NOT be judged statically — else they read as false positives.
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

/** A scenario whose finalChecks are all `actionCalled` (≥1) proves calls, not effects. */
function isActionCalledOnly(file: string): boolean {
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  // Only judge scenarios whose complete finalChecks are statically visible.
  if (!isDirectScenarioExport(sf)) return false;
  const types = finalCheckTypes(sf);
  if (types.length === 0) return false;
  return types.every((t) => t === "actionCalled");
}

const flagged = SCENARIO_ROOTS.flatMap(walkScenarioFiles)
  .filter(isActionCalledOnly)
  .map((f) => relative(repoRoot, f));

// Current debt (theme 3 of #9310 — down from the 104 the issue reported as the
// corpus has been de-larped). Lower this as actionCalled-only scenarios are given
// a real effect finalCheck (custom predicate / memory / connector). Never raise.
const BASELINE = 25;

describe("action-effect ratchet (#9310)", () => {
  it("finds the scenario corpus (guard is actually scanning)", () => {
    const total = SCENARIO_ROOTS.flatMap(walkScenarioFiles).length;
    expect(total).toBeGreaterThan(400);
  });

  it(`does not grow actionCalled-only scenarios beyond ${BASELINE}`, () => {
    if (flagged.length > BASELINE) {
      const overflow = flagged.slice(BASELINE);
      throw new Error(
        `actionCalled-only scenarios grew to ${flagged.length} (baseline ${BASELINE}). ` +
          `A finalChecks array that is entirely 'actionCalled' proves the handler ran, ` +
          `not that it produced the right effect — add a 'custom'/'memoryWriteOccurred'/` +
          `'connectorDispatchOccurred' check that reads the produced state. New offenders:\n` +
          overflow.join("\n"),
      );
    }
    expect(flagged.length).toBeLessThanOrEqual(BASELINE);
  });
});
