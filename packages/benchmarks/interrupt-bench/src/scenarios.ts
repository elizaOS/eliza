/**
 * Load and validate scenario JSON files from `scenarios/`.
 *
 * Lightweight runtime validation: confirms the required top-level keys are
 * present and types are roughly right. Heavier shape validation lives in the
 * `tests/scenarios.test.ts` vitest suite.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Scenario } from "./types.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SCENARIO_DIR = join(HERE, "..", "scenarios");

function isScenarioShape(obj: unknown): obj is Scenario {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  if (typeof o.id !== "string") return false;
  if (typeof o.category !== "string") return false;
  if (typeof o.interruptionType !== "string") return false;
  if (typeof o.weight !== "number") return false;
  if (
    !o.setup ||
    !o.script ||
    !o.expectedFinalState ||
    !o.expectedTrace ||
    !o.responseRubric
  )
    return false;
  return true;
}

export function loadScenarios(): Scenario[] {
  const out: Scenario[] = [];
  for (const category of readdirSync(SCENARIO_DIR)) {
    const catPath = join(SCENARIO_DIR, category);
    let stat;
    try {
      stat = statSync(catPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const file of readdirSync(catPath)) {
      if (!file.endsWith(".json")) continue;
      const raw = readFileSync(join(catPath, file), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!isScenarioShape(parsed)) {
        throw new Error(`Scenario ${category}/${file} is malformed`);
      }
      out.push(parsed);
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

export function loadScenarioById(id: string): Scenario | null {
  return loadScenarios().find((s) => s.id === id) ?? null;
}
