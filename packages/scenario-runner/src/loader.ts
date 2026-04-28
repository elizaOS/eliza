/**
 * Scenario file discovery and loading. `run` imports scenario modules and
 * executes their top-level setup. `list` parses static metadata so discovery
 * does not load runtime-only modules.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import type { ScenarioDefinition } from "./types.ts";

async function walk(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir);
  for (const entry of entries) {
    if (entry.startsWith("_")) continue;
    const full = path.join(dir, entry);
    const st = await stat(full);
    if (st.isDirectory()) {
      await walk(full, out);
    } else if (entry.endsWith(".scenario.ts")) {
      out.push(full);
    }
  }
}

export interface LoadedScenario {
  file: string;
  scenario: ScenarioDefinition;
}

export interface ScenarioMetadata {
  file: string;
  id: string;
  status?: string;
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

export function matchesScenarioFileGlobs(
  file: string,
  fileGlobs: readonly string[],
): boolean {
  const resolvedFile = path.resolve(file);
  const absoluteFile = toPosixPath(resolvedFile);
  const cwdRelativeFile = toPosixPath(
    path.relative(process.cwd(), resolvedFile),
  );

  return fileGlobs.some((fileGlob) => {
    const normalizedGlob = toPosixPath(
      path.isAbsolute(fileGlob) ? path.resolve(fileGlob) : fileGlob,
    );
    if (path.posix.isAbsolute(normalizedGlob)) {
      return path.posix.matchesGlob(absoluteFile, normalizedGlob);
    }
    return path.posix.matchesGlob(cwdRelativeFile, normalizedGlob);
  });
}

function isScenarioDefinition(value: unknown): value is ScenarioDefinition {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    typeof obj.title === "string" &&
    typeof obj.domain === "string" &&
    Array.isArray(obj.turns)
  );
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text;
  }
  return null;
}

function staticStringValue(expression: ts.Expression): string | undefined {
  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    return expression.text;
  }
  return undefined;
}

function getStaticStringProperty(
  objectLiteral: ts.ObjectLiteralExpression,
  propertyName: string,
): string | undefined {
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = propertyNameText(property.name);
    if (name !== propertyName) continue;
    return staticStringValue(property.initializer);
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

export async function loadScenarioMetadataFile(
  file: string,
): Promise<ScenarioMetadata> {
  const sourceText = await readFile(file, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const objectLiteral = findExportedScenarioObject(sourceFile);
  if (!objectLiteral) {
    throw new Error(
      `[scenario-loader] ${file}: no statically readable scenario object in default export or exported 'scenario' value.`,
    );
  }
  const id = getStaticStringProperty(objectLiteral, "id");
  if (!id) {
    throw new Error(
      `[scenario-loader] ${file}: no statically readable scenario id in default export or exported 'scenario' value.`,
    );
  }
  return {
    file,
    id,
    status: getStaticStringProperty(objectLiteral, "status"),
  };
}

export async function discoverScenarios(root: string): Promise<string[]> {
  const files: string[] = [];
  const st = await stat(root);
  if (st.isFile()) {
    if (root.endsWith(".scenario.ts")) files.push(root);
  } else {
    await walk(root, files);
  }
  files.sort();
  return files;
}

export async function loadScenarioFile(file: string): Promise<LoadedScenario> {
  const mod = (await import(pathToFileURL(file).href)) as Record<
    string,
    unknown
  >;
  const candidate = mod.default ?? mod.scenario;
  if (!isScenarioDefinition(candidate)) {
    throw new Error(
      `[scenario-loader] ${file}: no default export or 'scenario' export matching ScenarioDefinition (need id/title/domain/turns).`,
    );
  }
  return { file, scenario: candidate };
}

export async function loadAllScenarios(
  root: string,
  filter?: Set<string>,
  fileGlobs?: readonly string[],
): Promise<LoadedScenario[]> {
  const files = await discoverScenarios(root);
  const loaded: LoadedScenario[] = [];
  const includePending = process.env.SCENARIO_INCLUDE_PENDING === "1";
  for (const file of files) {
    if (fileGlobs && fileGlobs.length > 0) {
      if (!matchesScenarioFileGlobs(file, fileGlobs)) {
        continue;
      }
    }
    const result = await loadScenarioFile(file);
    if (filter && !filter.has(result.scenario.id)) continue;
    if (result.scenario.status === "pending" && !includePending) continue;
    loaded.push(result);
  }
  return loaded;
}

export async function listScenarioMetadata(
  root: string,
  filter?: Set<string>,
  fileGlobs?: readonly string[],
): Promise<ScenarioMetadata[]> {
  const files = await discoverScenarios(root);
  const loaded: ScenarioMetadata[] = [];
  const includePending = process.env.SCENARIO_INCLUDE_PENDING === "1";
  for (const file of files) {
    if (fileGlobs && fileGlobs.length > 0) {
      if (!matchesScenarioFileGlobs(file, fileGlobs)) {
        continue;
      }
    }
    const result = await loadScenarioMetadataFile(file);
    if (filter && !filter.has(result.id)) continue;
    if (result.status === "pending" && !includePending) continue;
    loaded.push(result);
  }
  return loaded;
}
