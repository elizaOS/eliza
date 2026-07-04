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
import { findCatalogModel, isDefaultEligibleId } from "./catalog";
import { isVerifiedCuratedEliza1Download } from "./catalog-policy";
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

function isCuratedEliza1AssignmentId(modelId: string): boolean {
  const catalog = findCatalogModel(modelId);
  return (
    !!catalog &&
    !catalog.hiddenFromCatalog &&
    catalog.runtimeRole !== "mtp-drafter" &&
    isDefaultEligibleId(catalog.id)
  );
}

function sanitizeAssignments(assignments: ModelAssignments): ModelAssignments {
  const next: ModelAssignments = {};
  for (const [slot, modelId] of Object.entries(assignments) as Array<
    [AgentModelSlot, string | undefined]
  >) {
    if (!modelId || !isCuratedEliza1AssignmentId(modelId)) continue;
    next[slot] = modelId;
  }
  return next;
}

async function ensureRoot(): Promise<void> {
  await fs.mkdir(localInferenceRoot(), { recursive: true });
}

export async function readAssignments(): Promise<ModelAssignments> {
  try {
    const raw = await fs.readFile(assignmentsPath(), "utf8");
    const parsed = JSON.parse(raw) as AssignmentsFile;
    if (parsed?.version !== 1 || !parsed.assignments) return {};
    return sanitizeAssignments(parsed.assignments);
  } catch {
    // error-policy:J3 the assignments file is absent on first run (ENOENT) and
    // may be truncated by a crash mid-write; either way "no model assignments"
    // ({}) is a valid start-clean state, not a fabricated success — callers
    // fall back to auto-selection.
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

/**
 * Build slot recommendations from currently-installed models.
 *
 * Only default-eligible Eliza-1 downloads are auto-recommended.
 * External-scan blobs and ad-hoc Hugging Face downloads are never assigned to
 * agent slots.
 *
 * Why: external blobs may use newer architectures or quant formats outside
 * the bundled Eliza-1 FFI runtime's supported set. Auto-loading an external
 * blob the user never selected silently breaks PROACTIVE_AGENT and other
 * background tasks at boot.
 */
export function buildRecommendedAssignments(
  installed: InstalledModel[],
): ModelAssignments {
  const ownDownloads = installed.filter(isVerifiedCuratedEliza1Download);
  const best = pickLargestInstalledModel(ownDownloads);
  if (!best) return {};
  return {
    TEXT_SMALL: best.id,
    TEXT_LARGE: best.id,
    TEXT_TO_SPEECH: best.id,
    TRANSCRIPTION: best.id,
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
    if (!isCuratedEliza1AssignmentId(modelId)) {
      throw new Error(
        "Local inference assignments are limited to curated Eliza-1 tiers.",
      );
    }
    next[slot] = modelId;
  } else {
    delete next[slot];
  }
  await writeAssignments(next);
  return next;
}

/**
 * Decide which slots a freshly-installed model is a sensible default for.
 *
 * Today the curated catalog tags models with `category` ∈
 * `chat | code | tools | tiny | reasoning` and `bucket` ∈
 * `small | mid | large | xl` — no explicit "embedding" tag, because the
 * default catalog ships only generative models. The defensive check below
 * still recognizes an "embedding" category/bucket for future curated catalog
 * additions and legacy assignment files whose ids contain a recognizable
 * embedding-family marker (`nomic-embed`, `bge`, `all-minilm`, `gte`, `e5-`).
 */
function isEmbeddingModelId(modelId: string): boolean {
  const catalog = findCatalogModel(modelId);
  if (catalog) {
    if ((catalog.category as string) === "embedding") return true;
    if ((catalog.bucket as string) === "embedding") return true;
    return false;
  }
  const lowered = modelId.toLowerCase();
  return (
    lowered.includes("nomic-embed") ||
    lowered.includes("bge-") ||
    lowered.includes("all-minilm") ||
    lowered.includes("gte-") ||
    lowered.includes("e5-")
  );
}

/**
 * Fill empty assignment slots with `modelId`. Idempotent: never overwrites
 * an existing slot. Embedding models only fill `TEXT_EMBEDDING`; generative
 * models only fill `TEXT_SMALL` and `TEXT_LARGE`. Returns the resulting
 * assignment map (read state is `readAssignments()`, not effective +
 * recommended).
 *
 * Wired from the downloader's success path and the runtime boot's
 * "exactly one model installed, no assignments" branch so first-light
 * users land in chat without a Settings detour. The hard error in
 * `ensure-local-inference-handler.ts` only fires when the operator has
 * actively cleared the assignment.
 */
export async function ensureDefaultAssignment(
  modelId: string,
): Promise<ModelAssignments> {
  const current = await readAssignments();
  if (!isDefaultEligibleId(modelId)) return current;

  const next: ModelAssignments = { ...current };

  if (isEmbeddingModelId(modelId)) {
    if (!next.TEXT_EMBEDDING) next.TEXT_EMBEDDING = modelId;
  } else {
    if (!next.TEXT_SMALL) next.TEXT_SMALL = modelId;
    if (!next.TEXT_LARGE) next.TEXT_LARGE = modelId;
    if (!next.TEXT_TO_SPEECH) next.TEXT_TO_SPEECH = modelId;
    if (!next.TRANSCRIPTION) next.TRANSCRIPTION = modelId;
  }

  // Cheap shortcut: skip the rewrite when nothing changed.
  if (
    next.TEXT_SMALL === current.TEXT_SMALL &&
    next.TEXT_LARGE === current.TEXT_LARGE &&
    next.TEXT_EMBEDDING === current.TEXT_EMBEDDING &&
    next.TEXT_TO_SPEECH === current.TEXT_TO_SPEECH &&
    next.TRANSCRIPTION === current.TRANSCRIPTION
  ) {
    return current;
  }

  await writeAssignments(next);
  return next;
}

/**
 * Boot-time helper. If exactly one default-eligible Eliza-1 model is
 * installed and no assignment file exists yet, auto-fill its slots so
 * the first session works without the user opening Settings. No-op when
 * assignments are already present or when more than one default-eligible
 * model is installed (we cannot guess intent).
 *
 * External-scan blobs and custom Hugging Face downloads are intentionally
 * excluded - see `buildRecommendedAssignments` for the rationale.
 */
export async function autoAssignAtBoot(
  installed: InstalledModel[],
): Promise<ModelAssignments | null> {
  const ownDownloads = installed.filter(isVerifiedCuratedEliza1Download);
  if (ownDownloads.length !== 1) return null;
  const current = await readAssignments();
  if (Object.keys(current).length > 0) return null;
  const onlyInstalled = ownDownloads[0];
  if (!onlyInstalled || typeof onlyInstalled.id !== "string") return null;
  return ensureDefaultAssignment(onlyInstalled.id);
}
