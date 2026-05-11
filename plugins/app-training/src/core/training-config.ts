/**
 * Auto-training configuration: persisted at `<state>/training/config.json`.
 *
 * Self-contained on purpose. The agent-wide config schema is large and changes
 * coordinated across multiple teams; auto-training has a small, stable surface
 * that is easier to evolve from a dedicated file. Loader merges file contents
 * over typed defaults; absent fields fall through to the defaults.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveStateDir } from "@elizaos/core";
import type { TrajectoryTrainingTask } from "./trajectory-task-datasets.js";

export type TrainingBackend = "tinker" | "native";

export const ALL_TRAINING_BACKENDS: readonly TrainingBackend[] = [
  "tinker",
  "native",
] as const;

export const ALL_TRAINING_TASKS: readonly TrajectoryTrainingTask[] = [
  "should_respond",
  "context_routing",
  "action_planner",
  "response",
  "media_description",
] as const;

export interface PerTaskOverride {
  threshold?: number;
  cooldownHours?: number;
  backend?: TrainingBackend;
}

export interface TrainingConfig {
  /** Auto-train enabled by default. */
  autoTrain: boolean;
  /** Trajectory count per task that triggers a run. */
  triggerThreshold: number;
  /** Minimum hours between consecutive runs for the same task. */
  triggerCooldownHours: number;
  /**
   * Backends to dispatch to on threshold/cron firings. Empty list means
   * "no backend configured" — counters still tick, but threshold-fired
   * training is skipped (with a logger note). Manual triggers always allow
   * the caller to specify a backend explicitly.
   *
   * Defaults to `[]` until Phase 5 wires the `native` backend.
   */
  backends: TrainingBackend[];
  perTaskOverrides?: Partial<Record<TrajectoryTrainingTask, PerTaskOverride>>;
}

export const DEFAULT_TRAINING_CONFIG: TrainingConfig = Object.freeze({
  autoTrain: true,
  triggerThreshold: 100,
  triggerCooldownHours: 12,
  // Native is the default-on backend. It runs in-process against the
  // configured runtime model and writes optimized prompts into the
  // OptimizedPromptService store. Operators can prepend other non-Google
  // backends when they want hosted training instead.
  backends: ["native"],
}) as TrainingConfig;

export function trainingStateRoot(): string {
  return join(resolveStateDir(), "training");
}

export function trainingConfigPath(): string {
  return join(trainingStateRoot(), "config.json");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceBackend(value: unknown): TrainingBackend | null {
  return typeof value === "string" &&
    (ALL_TRAINING_BACKENDS as readonly string[]).includes(value)
    ? (value as TrainingBackend)
    : null;
}

function coercePerTaskOverrides(
  value: unknown,
): Partial<Record<TrajectoryTrainingTask, PerTaskOverride>> | undefined {
  if (!isStringRecord(value)) return undefined;
  const out: Partial<Record<TrajectoryTrainingTask, PerTaskOverride>> = {};
  for (const task of ALL_TRAINING_TASKS) {
    const raw = value[task];
    if (!isStringRecord(raw)) continue;
    const override: PerTaskOverride = {};
    if (isFiniteNumber(raw.threshold) && raw.threshold > 0) {
      override.threshold = Math.floor(raw.threshold);
    }
    if (isFiniteNumber(raw.cooldownHours) && raw.cooldownHours >= 0) {
      override.cooldownHours = raw.cooldownHours;
    }
    const backend = coerceBackend(raw.backend);
    if (backend) override.backend = backend;
    if (Object.keys(override).length > 0) out[task] = override;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Merge an arbitrary JSON object over the typed defaults. Unknown keys are
 * dropped; invalid types fall back to the default value for that field.
 */
export function normalizeTrainingConfig(input: unknown): TrainingConfig {
  const base: TrainingConfig = {
    autoTrain: DEFAULT_TRAINING_CONFIG.autoTrain,
    triggerThreshold: DEFAULT_TRAINING_CONFIG.triggerThreshold,
    triggerCooldownHours: DEFAULT_TRAINING_CONFIG.triggerCooldownHours,
    backends: [...DEFAULT_TRAINING_CONFIG.backends],
  };
  if (!isStringRecord(input)) return base;

  if (typeof input.autoTrain === "boolean") base.autoTrain = input.autoTrain;
  if (isFiniteNumber(input.triggerThreshold) && input.triggerThreshold > 0) {
    base.triggerThreshold = Math.floor(input.triggerThreshold);
  }
  if (
    isFiniteNumber(input.triggerCooldownHours) &&
    input.triggerCooldownHours >= 0
  ) {
    base.triggerCooldownHours = input.triggerCooldownHours;
  }
  if (Array.isArray(input.backends)) {
    const seen = new Set<TrainingBackend>();
    for (const entry of input.backends) {
      const backend = coerceBackend(entry);
      if (backend && !seen.has(backend)) seen.add(backend);
    }
    base.backends = [...seen];
  }
  const overrides = coercePerTaskOverrides(input.perTaskOverrides);
  if (overrides) base.perTaskOverrides = overrides;
  return base;
}

export function loadTrainingConfig(): TrainingConfig {
  const path = trainingConfigPath();
  if (!existsSync(path)) return normalizeTrainingConfig(undefined);
  const raw = readFileSync(path, "utf-8");
  return normalizeTrainingConfig(JSON.parse(raw));
}

export function saveTrainingConfig(config: TrainingConfig): void {
  const path = trainingConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  const normalized = normalizeTrainingConfig(config);
  writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
}

export interface ResolvedTaskPolicy {
  threshold: number;
  cooldownMs: number;
  backend: TrainingBackend | null;
}

export function resolveTaskPolicy(
  config: TrainingConfig,
  task: TrajectoryTrainingTask,
): ResolvedTaskPolicy {
  const override = config.perTaskOverrides?.[task];
  const threshold = override?.threshold ?? config.triggerThreshold;
  const cooldownHours = override?.cooldownHours ?? config.triggerCooldownHours;
  const backend = override?.backend ?? config.backends[0] ?? null;
  return {
    threshold,
    cooldownMs: Math.max(0, cooldownHours * 3_600_000),
    backend,
  };
}
