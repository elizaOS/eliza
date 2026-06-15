/**
 * `ENTITY` umbrella action — STUB.
 *
 * Op-based dispatch over the relationships knowledge graph:
 *   - `create`             create a person/org/place/project/concept
 *   - `read`               fetch a single entity
 *   - `list`               list known entities
 *   - `log_interaction`    record an inbound/outbound interaction
 *   - `set_identity`       observe a (platform, handle) identity for an entity
 *   - `set_relationship`   upsert a typed edge between two entities
 *   - `merge`              merge duplicate entities (delegates to merge engine)
 *
 * Follow-up cadence (`add_follow_up`, `mark_followup_done`,
 * `list_overdue_followups`, …) intentionally stays on `SCHEDULED_TASKS`.
 *
 * TODO(decomposition): port the real implementation from
 *   `plugins/plugin-personal-assistant/src/actions/entity.ts`
 * and the underlying stores from:
 *   - `plugins/plugin-personal-assistant/src/lifeops/entities/store.ts`        (EntityStore)
 *   - `plugins/plugin-personal-assistant/src/lifeops/entities/merge.ts`        (merge engine)
 *   - `plugins/plugin-personal-assistant/src/lifeops/entities/voice-observer-bridge.ts`
 *   - `plugins/plugin-personal-assistant/src/lifeops/relationships/store.ts`   (RelationshipStore)
 *
 * For now the handler returns a TODO marker so the plugin compiles and registers.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

import {
  ENTITY_OPS,
  RELATIONSHIPS_CONTEXTS,
  RELATIONSHIPS_LOG_PREFIX,
  type EntityOp,
} from "../types.js";

/**
 * Parameter shape mirrors the LifeOps `EntityParameters` in
 * `plugins/plugin-personal-assistant/src/actions/entity.ts`. Kept loose (`unknown` /
 * optional) so the stub does not block typecheck while the real port lands.
 */
export interface EntityActionParameters {
  /** Canonical op name. Planner may also provide `action` as an alias. */
  op?: EntityOp;
  subaction?: EntityOp;
  action?: EntityOp;
  /** Free-form planner intent describing why this op was chosen. */
  intent?: string;
  /** Entity kind for `create` (person / organization / place / project / concept). */
  kind?: string;
  /** Display name for `create` / `set_identity`. */
  name?: string;
  /** Target entity id for `read` / `set_identity` / `set_relationship` / `merge`. */
  entityId?: string;
  /** Identity platform for `set_identity` (e.g. `discord`, `email`, `phone`). */
  platform?: string;
  /** Handle on `platform` for `set_identity`. */
  handle?: string;
  /** Display name shown for an observed identity. */
  displayName?: string;
  /** Edge target id for `set_relationship`. */
  toEntityId?: string;
  /** Edge source id for `set_relationship`. Defaults to `self`. */
  fromEntityId?: string;
  /** Edge type label for `set_relationship` (e.g. `manages`). */
  relationshipType?: string;
  /** Source entity ids consumed when calling `merge`. */
  sourceEntityIds?: string[];
  /** Free-form evidence string for provenance trail. */
  evidence?: string;
  /** Generic entity payload shape used by some op dispatchers. */
  entity?: Record<string, unknown>;
}

function getParams(options: HandlerOptions | undefined): EntityActionParameters {
  const params = options?.parameters as EntityActionParameters | undefined;
  return params ?? {};
}

function resolveOp(params: EntityActionParameters): EntityOp | undefined {
  const candidate = params.op ?? params.subaction ?? params.action;
  if (typeof candidate !== "string") return undefined;
  if ((ENTITY_OPS as readonly string[]).includes(candidate)) {
    return candidate as EntityOp;
  }
  return undefined;
}

export const entityAction: Action = {
  name: "ENTITY",
  similes: ["CONTACT", "PERSON", "ORGANIZATION", "ENTITY_CRUD"],
  description:
    "Umbrella action for the relationships knowledge graph: person / org / place / project / concept CRUD, identity claims, typed relationships, and merge. STUB — real implementation lands in a follow-up port from `plugins/plugin-personal-assistant/src/actions/entity.ts`.",
  contexts: [...RELATIONSHIPS_CONTEXTS],
  contextGate: { anyOf: [...RELATIONSHIPS_CONTEXTS] },
  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    // TODO(decomposition): port the validator from lifeops which checks
    // `hasLifeOpsAccess(runtime, message)` and the entity-store readiness.
    return true;
  },
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: HandlerOptions,
    _callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const params = getParams(options);
    const op = resolveOp(params);
    const text =
      `${RELATIONSHIPS_LOG_PREFIX} TODO — ENTITY action stub. ` +
      `op=${op ?? "<unspecified>"}. ` +
      `Real handler will land in a follow-up port from ` +
      `plugins/plugin-personal-assistant/src/actions/entity.ts.`;
    return {
      success: true,
      text,
      data: { todo: true, op: op ?? null },
    };
  },
  examples: [],
};

export default entityAction;
