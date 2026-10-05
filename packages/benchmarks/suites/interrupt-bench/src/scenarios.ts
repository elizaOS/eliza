/**
 * Load and validate scenario JSON files from `scenarios/`.
 *
 * Lightweight runtime validation: confirms the required top-level keys are
 * present and types are roughly right. Heavier shape validation lives in the
 * `tests/scenarios.test.ts` vitest suite.
 */

import { readdirSync, readFileSync, type Stats, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Scenario, ScenarioScriptStep } from "./types.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SCENARIO_DIR = join(HERE, "..", "scenarios");
const EXPANSION_MULTIPLIER = 10;

type ScenarioVariant = {
  id: string;
  label: string;
  description: string;
  rewrite: (
    text: string,
    step: ScenarioScriptStep,
    index: number,
    scenario: Scenario,
  ) => string;
};

const EDGE_VARIANTS: ScenarioVariant[] = [
  {
    id: "polite",
    label: "polite framing",
    description: "Adds a polite setup to the first user turn.",
    rewrite: (text, _step, index) =>
      index === 0 ? `please help with this: ${text}` : text,
  },
  {
    id: "urgent",
    label: "urgent correction",
    description: "Frames the first turn as time-sensitive.",
    rewrite: (text, _step, index) =>
      index === 0 ? `this is time sensitive: ${text}` : text,
  },
  {
    id: "mobile",
    label: "mobile typing",
    description: "Adds a mobile-typed preface to the first turn.",
    rewrite: (text, _step, index) =>
      index === 0 ? `from my phone, quick note: ${text}` : text,
  },
  {
    id: "followup",
    label: "follow-up context",
    description: "Presents the first turn as continuing an earlier thread.",
    rewrite: (text, _step, index) =>
      index === 0 ? `following up from earlier: ${text}` : text,
  },
  {
    id: "quoted",
    label: "quoted handoff",
    description: "Quotes the first turn as a forwarded request.",
    rewrite: (text, _step, index) =>
      index === 0 ? `forwarded request:\n> ${text}` : text,
  },
  {
    id: "context",
    label: "extra context",
    description: "Adds operational context before the first turn.",
    rewrite: (text, _step, index, scenario) =>
      index === 0
        ? `context: ${scenario.category} interruption test\n${text}`
        : text,
  },
  {
    id: "ack",
    label: "ack requested",
    description: "Asks for a brief acknowledgement on the first turn.",
    rewrite: (text, _step, index) =>
      index === 0 ? `please keep the reply brief: ${text}` : text,
  },
  {
    id: "noisy",
    label: "chat noise",
    description: "Adds natural chat filler to the first turn.",
    rewrite: (text, _step, index) =>
      index === 0 ? `hey, sorry for the messy message, ${text}` : text,
  },
  {
    id: "boundary",
    label: "instruction boundary",
    description: "Marks the first turn as the beginning of user intent.",
    rewrite: (text, _step, index) =>
      index === 0 ? `user intent starts here:\n${text}` : text,
  },
  {
    id: "handoff",
    label: "teammate handoff",
    description: "Frames the first turn as delegated by another person.",
    rewrite: (text, _step, index) =>
      index === 0 ? `my teammate asked me to handle this: ${text}` : text,
  },
];

if (EDGE_VARIANTS.length !== EXPANSION_MULTIPLIER) {
  throw new Error(
    `InterruptBench expansion requires exactly ${EXPANSION_MULTIPLIER} variants, found ${EDGE_VARIANTS.length}`,
  );
}

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

function loadBaseScenarios(): Scenario[] {
  const out: Scenario[] = [];
  for (const category of readdirSync(SCENARIO_DIR)) {
    const catPath = join(SCENARIO_DIR, category);
    let stat: Stats;
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

function cloneScenario(scenario: Scenario): Scenario {
  return JSON.parse(JSON.stringify(scenario)) as Scenario;
}

function applyVariant(scenario: Scenario, variant: ScenarioVariant): Scenario {
  const expanded = cloneScenario(scenario);
  expanded.id = `${scenario.id}--edge-${variant.id}`;
  expanded.description = `${scenario.description ?? scenario.id} Edge variant: ${variant.description}`;
  expanded.script = scenario.script.map((step, index) => ({
    ...step,
    text: variant.rewrite(step.text, step, index, scenario),
  }));
  return expanded;
}

export function getBaseScenarioId(id: string): string {
  return id.replace(/--edge-[a-z-]+$/, "");
}

export function loadBaseScenarioSet(): Scenario[] {
  return loadBaseScenarios();
}

export function loadExpandedScenarios(): Scenario[] {
  const base = loadBaseScenarios();
  const expanded = base.flatMap((scenario) =>
    EDGE_VARIANTS.map((variant) => applyVariant(scenario, variant)),
  );
  if (expanded.length !== base.length * EXPANSION_MULTIPLIER) {
    throw new Error(
      `InterruptBench scenario expansion mismatch: expected ${base.length * EXPANSION_MULTIPLIER}, found ${expanded.length}`,
    );
  }
  return expanded;
}

export function loadScenarios(): Scenario[] {
  return [...loadBaseScenarios(), ...loadExpandedScenarios()];
}

export function loadScenarioById(id: string): Scenario | null {
  return loadScenarios().find((s) => s.id === id) ?? null;
}

export function countInterruptBenchScenarios(): {
  suite: "interrupt-bench";
  existing: number;
  added: number;
  total: number;
  multiplierAdded: number;
} {
  const base = loadBaseScenarios();
  const expanded = loadExpandedScenarios();
  return {
    suite: "interrupt-bench",
    existing: base.length,
    added: expanded.length,
    total: base.length + expanded.length,
    multiplierAdded: expanded.length / base.length,
  };
}

export function validateInterruptBenchScenarios(): {
  valid: boolean;
  total: number;
  uniqueIds: number;
  duplicateIds: string[];
  emptyScriptSteps: string[];
  expansionMatches: boolean;
} {
  const base = loadBaseScenarios();
  const expanded = loadExpandedScenarios();
  const all = [...base, ...expanded];
  const ids = new Set<string>();
  const duplicateIds = new Set<string>();
  const emptyScriptSteps: string[] = [];

  for (const scenario of all) {
    if (ids.has(scenario.id)) duplicateIds.add(scenario.id);
    ids.add(scenario.id);
    if (
      scenario.script.length === 0 ||
      scenario.script.some((step) => step.text.trim().length === 0)
    ) {
      emptyScriptSteps.push(scenario.id);
    }
  }

  const expansionMatches =
    expanded.length === base.length * EXPANSION_MULTIPLIER;

  return {
    valid:
      duplicateIds.size === 0 &&
      emptyScriptSteps.length === 0 &&
      expansionMatches,
    total: all.length,
    uniqueIds: ids.size,
    duplicateIds: [...duplicateIds],
    emptyScriptSteps,
    expansionMatches,
  };
}
