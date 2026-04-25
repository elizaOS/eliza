/**
 * Scenario file discovery and loading. Scenarios export either a default or
 * a named `scenario` value that was produced by `@elizaos/scenario-schema`'s
 * identity `scenario()` factory. We duck-type the returned value rather than
 * validating with Zod — the WS7 shim deliberately leaves this unconstrained.
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
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
