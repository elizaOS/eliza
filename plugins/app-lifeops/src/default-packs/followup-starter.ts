/**
 * Default pack: `followup-starter` — cadence watcher per GAP §3.13.
 *
 * Ships a single `kind: "watcher"` `ScheduledTask` whose prompt scans
 * `RelationshipStore.list({ cadenceOverdueAsOf: now })` and creates child
 * `ScheduledTask` records with:
 *   - `kind: "followup"`
 *   - `subject: { kind: "relationship", id: <relationshipId> }`
 *   - `completionCheck.kind: "subject_updated"` so any new interaction on
 *     the edge resolves the followup.
 *
 * Cadence lives on the edge (per wave1-interfaces.md §7.2 and GAP §3.13);
 * the watcher reads the edge, not the entity.
 *
 * Stub status: see `contract-stubs.ts` — `RelationshipStore` is declared
 * locally until W1-E ships the real store.
 */

import type {
  RelationshipStoreStub,
  ScheduledTaskSeed,
} from "./contract-stubs.js";
import type { DefaultPack } from "./registry-types.js";

export const FOLLOWUP_STARTER_PACK_KEY = "followup-starter";

export const FOLLOWUP_STARTER_RECORD_IDS = {
  watcher: "default-pack:followup-starter:cadence-watcher",
} as const;

/**
 * Fallback cadence used by the RelationshipStore overdue resolver when an
 * edge does not carry its own `metadata.cadenceDays`. Per IMPL §7.1: 14 days
 * keeps "stay-in-touch" cadence loose enough for the long tail of
 * relationships while leaving room for tighter overrides on closer edges
 * (e.g. `colleague_of` may carry `cadenceDays: 7`, `friend_of` may stay at
 * 14). The W3-A 7-day simulation supports 14 as the default — the followup
 * watcher fires daily but emits zero children when no edge is overdue.
 */
export const DEFAULT_FOLLOWUP_CADENCE_DAYS = 14;

const watcherRecord: ScheduledTaskSeed = {
  kind: "watcher",
  promptInstructions:
    "Scan RelationshipStore for cadence-overdue edges (relationships whose last interaction is older than the edge's metadata.cadenceDays). For each overdue edge, create a child followup ScheduledTask with subject={kind:'relationship',id} and completionCheck.kind='subject_updated' so any new interaction on the edge resolves it. Do not surface anything to the owner directly — the morning brief consolidation will fold the new followup tasks in.",
  contextRequest: {
    includeOwnerFacts: ["preferredName", "timezone"],
  },
  // Daily fire on the morning anchor so the followup tasks are ready before
  // the morning brief assembles.
  trigger: {
    kind: "relative_to_anchor",
    anchorKey: "wake.confirmed",
    offsetMinutes: 0,
  },
  priority: "low",
  respectsGlobalPause: true,
  source: "default_pack",
  createdBy: FOLLOWUP_STARTER_PACK_KEY,
  ownerVisible: false,
  idempotencyKey: FOLLOWUP_STARTER_RECORD_IDS.watcher,
  metadata: {
    packKey: FOLLOWUP_STARTER_PACK_KEY,
    recordKey: "cadence-watcher",
  },
};

/**
 * Template for the child followup task created per overdue relationship.
 * Returned by the watcher's helper (see `buildFollowupTaskForRelationship`)
 * so the runner can persist it.
 */
export function buildFollowupTaskForRelationship(args: {
  relationshipId: string;
  fromEntityId: string;
  toEntityId: string;
  cadenceDays: number;
}): ScheduledTaskSeed {
  return {
    kind: "followup",
    promptInstructions:
      "Surface a gentle follow-up nudge for an overdue relationship cadence. Reference the person by their preferred name from EntityStore; do not invent context. One sentence; the owner can dismiss or act.",
    contextRequest: {
      includeRelationships: { relationshipIds: [args.relationshipId] },
      includeEntities: {
        entityIds: [args.fromEntityId, args.toEntityId],
        fields: ["preferredName", "type", "state.lastInteractionPlatform"],
      },
    },
    trigger: { kind: "manual" },
    priority: "low",
    completionCheck: {
      kind: "subject_updated",
      // The runner watches RelationshipStore for any new interaction on the
      // subject relationship; that observation fires `complete`.
      params: { subjectKind: "relationship", id: args.relationshipId },
    },
    subject: {
      kind: "relationship",
      id: args.relationshipId,
    },
    respectsGlobalPause: true,
    source: "default_pack",
    createdBy: FOLLOWUP_STARTER_PACK_KEY,
    ownerVisible: true,
    idempotencyKey: `default-pack:followup-starter:${args.relationshipId}`,
    metadata: {
      packKey: FOLLOWUP_STARTER_PACK_KEY,
      recordKey: "followup-child",
      cadenceDays: args.cadenceDays,
    },
  };
}

export const followupStarterPack: DefaultPack = {
  key: FOLLOWUP_STARTER_PACK_KEY,
  label: "Cadence follow-ups",
  description:
    "Daily watcher reads RelationshipStore for overdue cadence edges and emits a follow-up task per overdue edge. Default cadence is 14 days; per-edge overrides via Relationship.metadata.cadenceDays let closer relationships carry tighter cadences. The morning brief folds emissions in. Resolves automatically when any new interaction is observed on the edge.",
  defaultEnabled: true,
  records: [watcherRecord],
  uiHints: {
    summaryOnDayOne:
      "Silent until a tracked relationship goes past its cadence window — then surfaces in the morning brief.",
    expectedFireCountPerDay: 0,
  },
};

/**
 * Helper for the watcher: read the overdue edges and emit child task seeds.
 * The runner calls this and persists the returned records.
 */
export async function deriveOverdueFollowupTasks(
  store: RelationshipStoreStub,
  options: { now?: Date } = {},
): Promise<ScheduledTaskSeed[]> {
  const now = options.now ?? new Date();
  const overdue = await store.list({ cadenceOverdueAsOf: now.toISOString() });
  return overdue.map((edge) => {
    const cadenceDaysRaw = edge.metadata?.cadenceDays;
    const cadenceDays =
      typeof cadenceDaysRaw === "number" && Number.isFinite(cadenceDaysRaw)
        ? cadenceDaysRaw
        : 0;
    return buildFollowupTaskForRelationship({
      relationshipId: edge.relationshipId,
      fromEntityId: edge.fromEntityId,
      toEntityId: edge.toEntityId,
      cadenceDays,
    });
  });
}
