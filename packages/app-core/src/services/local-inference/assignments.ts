/**
 * Per-ModelType model assignment store.
 *
 * Separate from the "active loaded model" concept in `ActiveModelCoordinator`.
 * Assignments are a *policy* — the user's declared intent that
 * `ModelType.TEXT_SMALL` should be served by model X and `TEXT_LARGE` by
 * model Y. The runtime's model handlers lazy-load whichever assignment
 * fires; the coordinator handles the actual swap in and out of memory.
 *
 * Stored in `$ELIZA_STATE_DIR/local-inference/assignments.json`. Cheap
 * enough to rewrite on every change — we never mutate in place.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { localInferenceRoot } from "./paths";
import { listInstalledModels } from "./registry";
import type { AgentModelSlot, InstalledModel, ModelAssignments } from "./types";

const ASSIGNMENTS_FILENAME = "assignments.json";

interface AssignmentsFile {
  version: 1;
  assignments: ModelAssignments;
}

function assignmentsPath(): string {
  return path.join(localInferenceRoot(), ASSIGNMENTS_FILENAME);
}

async function ensureRoot(): Promise<void> {
  await fs.mkdir(localInferenceRoot(), { recursive: true });
}

export async function readAssignments(): Promise<ModelAssignments> {
  try {
    const raw = await fs.readFile(assignmentsPath(), "utf8");
    const parsed = JSON.parse(raw) as AssignmentsFile;
    if (!parsed || parsed.version !== 1 || !parsed.assignments) return {};
    return parsed.assignments;
  } catch {
    return {};
  }
}

function pickLargestInstalledModel(
  installed: InstalledModel[],
): InstalledModel | null {
  return (
    installed
      .filter((model) => typeof model.id === "string" && model.id.length > 0)
      .sort((left, right) => right.sizeBytes - left.sizeBytes)[0] ?? null
  );
}

export function buildRecommendedAssignments(
  installed: InstalledModel[],
): ModelAssignments {
  const best = pickLargestInstalledModel(installed);
  if (!best) return {};
  return {
    TEXT_SMALL: best.id,
    TEXT_LARGE: best.id,
  };
}

export async function readEffectiveAssignments(): Promise<ModelAssignments> {
  const [saved, installed] = await Promise.all([
    readAssignments(),
    listInstalledModels(),
  ]);
  return {
    ...buildRecommendedAssignments(installed),
    ...saved,
  };
}

export async function writeAssignments(
  assignments: ModelAssignments,
): Promise<void> {
  await ensureRoot();
  const payload: AssignmentsFile = { version: 1, assignments };
  const tmp = `${assignmentsPath()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tmp, assignmentsPath());
}

export async function setAssignment(
  slot: AgentModelSlot,
  modelId: string | null,
): Promise<ModelAssignments> {
  const current = await readAssignments();
  const next: ModelAssignments = { ...current };
  if (modelId) {
    next[slot] = modelId;
  } else {
    delete next[slot];
  }
  await writeAssignments(next);
  return next;
}
