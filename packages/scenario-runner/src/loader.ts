/**
 * Scenario file discovery and loading. Scenarios export either a default or
 * a named `scenario` value that was produced by `@elizaos/scenario-schema`'s
 * identity `scenario()` factory. We duck-type the returned value rather than
 * validating with Zod — the WS7 shim deliberately leaves this unconstrained.
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
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

export async function loadScenarioFile(
  file: string,
): Promise<LoadedScenario> {
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
): Promise<LoadedScenario[]> {
  const files = await discoverScenarios(root);
  const loaded: LoadedScenario[] = [];
  for (const file of files) {
    const result = await loadScenarioFile(file);
    if (filter && !filter.has(result.scenario.id)) continue;
    loaded.push(result);
  }
  return loaded;
}
