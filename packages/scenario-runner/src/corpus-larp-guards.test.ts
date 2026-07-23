/**
 * Prohibits scenario shapes that pass without proving the behavior they claim
 * to test. Three larp modes are rejected outright across the scenario corpus:
 * a finalChecks array that is entirely `actionCalled` (proves the handler ran,
 * never that the right effect resulted), an echo-satisfiable
 * responseIncludesAny/All assertion (every keyword already appears in the
 * scenario's own user prompt turns, so parroting the input passes), and a
 * finalChecks array made only of silently-skippable check types
 * (`approvalRequestExists` / `pushSent` return a passing skip when their
 * capture service is absent). Only scenarios exporting `scenario({...})`
 * directly are judged on finalChecks — factory-built scenarios augment their
 * checks inside the factory, so their file-local array is a fragment.
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

/** The finalCheck types that return a PASSING `skipped-dependency-missing`. */
const SKIPPABLE = new Set(["approvalRequestExists", "pushSent"]);

// Generic acknowledgement keywords are not meaningful "echo" even when present
// in input — they say nothing about the scenario's behaviour either way.
const STOPWORDS = new Set([
  "ok",
  "okay",
  "yes",
  "no",
  "done",
  "sure",
  "got it",
  "thanks",
]);

const TEXT_LITERAL = /\btext:\s*"((?:[^"\\]|\\.)*)"/g;
const INCLUDES_ARRAY = /responseIncludes(?:Any|All):\s*\[([^\]]*)\]/g;
const STRING_LITERAL = /"((?:[^"\\]|\\.)*)"/g;
const ID_LITERAL = /\bid:\s*"((?:[^"\\]|\\.)*)"/;

function isEchoSatisfiable(src: string): boolean {
  const corpus = [...src.matchAll(TEXT_LITERAL)]
    .map((m) => m[1].toLowerCase())
    .join("  ||  ");
  if (!corpus) return false;
  for (const arr of src.matchAll(INCLUDES_ARRAY)) {
    const keywords = [...arr[1].matchAll(STRING_LITERAL)]
      .map((m) => m[1].toLowerCase().trim())
      .filter(Boolean);
    if (keywords.length === 0) continue;
    // Echo-satisfiable iff every keyword in the array is present in the
    // scenario's own input text (so the assertion can never fail on echo).
    const everyKeywordEchoes = keywords.every((k) => corpus.includes(k));
    const hasMeaningfulKeyword = keywords.some((k) => !STOPWORDS.has(k));
    if (everyKeywordEchoes && hasMeaningfulKeyword) return true;
  }
  return false;
}

interface CorpusFile {
  file: string;
  src: string;
  sourceFile: ts.SourceFile;
}

function label(entry: CorpusFile): string {
  const id = entry.src.match(ID_LITERAL)?.[1];
  const rel = relative(repoRoot, entry.file);
  return id ? `${id} (${rel})` : rel;
}

const corpus: CorpusFile[] = SCENARIO_ROOTS.flatMap(walkScenarioFiles).map(
  (file) => {
    const src = readFileSync(file, "utf8");
    return {
      file,
      src,
      sourceFile: ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true),
    };
  },
);

/** finalCheck types when the file's complete set is statically visible, else null. */
function directFinalCheckTypes(entry: CorpusFile): string[] | null {
  if (!isDirectScenarioExport(entry.sourceFile)) return null;
  const types = finalCheckTypes(entry.sourceFile);
  return types.length > 0 ? types : null;
}

describe("scenario corpus larp guards", () => {
  it("finds the scenario corpus (guards are actually scanning)", () => {
    expect(corpus.length).toBeGreaterThan(0);
  });

  it("forbids scenarios whose finalChecks are entirely actionCalled", () => {
    const offenders = corpus
      .filter((entry) =>
        directFinalCheckTypes(entry)?.every((t) => t === "actionCalled"),
      )
      .map(label)
      .sort();
    expect(
      offenders,
      `A finalChecks array that is entirely 'actionCalled' proves the handler ran, ` +
        `not that it produced the right effect — add a 'custom'/'memoryWriteOccurred'/` +
        `'connectorDispatchOccurred' check that reads the produced state. Offenders:\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("forbids echo-satisfiable response assertions", () => {
    const offenders = corpus
      .filter((entry) => isEchoSatisfiable(entry.src))
      .map(label)
      .sort();
    expect(
      offenders,
      `responseIncludesAny/All assertions whose keywords all appear in the scenario's own ` +
        `input text are echo-larp — the agent passes by parroting the prompt. Assert the ` +
        `agent's effect instead (finalChecks / memory writes / connector ledger). Offenders:\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("forbids scenarios whose finalChecks are entirely silently-skippable", () => {
    const offenders = corpus
      .filter((entry) =>
        directFinalCheckTypes(entry)?.every((t) => SKIPPABLE.has(t)),
      )
      .map(label)
      .sort();
    expect(
      offenders,
      `A finalChecks array made only of ${[...SKIPPABLE].join("/")} passes vacuously ` +
        `when the approval/push capture service isn't registered — add a check that ` +
        `reads produced state (a 'custom' predicate, memory/DB read). Offenders:\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });
});
