/**
 * `KNOWLEDGE_GRAPH` umbrella action — direct CRUD over the runtime
 * knowledge graph.
 *
 * This is the relationships-plugin "extras" surface. The graph stores
 * themselves live in the runtime: `@elizaos/agent`'s
 * {@link KnowledgeGraphService} owns the per-agent `EntityStore` /
 * `RelationshipStore`. This action resolves that service and dispatches
 * graph operations onto it. No DB access, no merge engine, no LLM planning
 * lives here — those are runtime / PA concerns respectively.
 *
 * Op-based dispatch:
 *   - `create`             create a person/org/place/project/concept node
 *   - `read`               fetch a single entity by id
 *   - `list`               list known entities (optionally filtered by kind)
 *   - `log_interaction`    record an inbound/outbound interaction on an entity
 *   - `set_identity`       observe a verified (platform, handle) identity
 *   - `set_relationship`   upsert a typed edge between two entities
 *   - `merge`              fold duplicate entities into a target
 *
 * Owner-only (`roleGate.minRole: OWNER` + the {@link hasOwnerAccess} gate).
 *
 * NOTE on naming: this action is `KNOWLEDGE_GRAPH`, NOT `ENTITY`.
 * `@elizaos/plugin-personal-assistant` registers the `ENTITY` action (a rich
 * orchestration over the legacy Rolodex contact model with an LLM planner +
 * voice-grounded replies). That stays in PA; this action is the thin runtime
 * graph-CRUD surface that powers the relationships viewer. Registering it
 * under a distinct name keeps exactly one `ENTITY` action at runtime.
 */

import { hasOwnerAccess, resolveKnowledgeGraphService } from "@elizaos/agent";
import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { Entity, EntityIdentity } from "@elizaos/shared";
import { SELF_ENTITY_ID } from "@elizaos/shared";

import {
  ENTITY_OPS,
  type EntityOp,
  RELATIONSHIPS_ACTION_NAME,
  RELATIONSHIPS_CONTEXTS,
  RELATIONSHIPS_LOG_PREFIX,
} from "../types.js";

/**
 * Parameter shape accepted by the action. The planner provides these via
 * `options.parameters`; every field is optional and validated per-op.
 */
export interface EntityActionParameters {
  /** Canonical op name. Planner may also provide `action` / `subaction`. */
  op?: EntityOp;
  subaction?: EntityOp;
  action?: EntityOp;
  /** Entity kind for `create` / `list` filter (person / organization / …). */
  kind?: string;
  /** Display name for `create`. */
  name?: string;
  /** Target entity id for `read` / `log_interaction` / `merge` target. */
  entityId?: string;
  /** Identity platform for `set_identity` (e.g. `discord`, `email`). */
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
  /** Interaction direction for `log_interaction`. Defaults to `outbound`. */
  direction?: "inbound" | "outbound";
  /** Interaction summary text for `log_interaction`. */
  summary?: string;
  /** Limit for `list`. */
  limit?: number;
}

function getParams(
  options: HandlerOptions | undefined,
): EntityActionParameters {
  const params = options?.parameters as EntityActionParameters | undefined;
  return params ?? {};
}

function resolveOp(params: EntityActionParameters): EntityOp | null {
  const candidate = params.op ?? params.subaction ?? params.action;
  if (typeof candidate !== "string") return null;
  return (ENTITY_OPS as readonly string[]).includes(candidate)
    ? (candidate as EntityOp)
    : null;
}

function trimmed(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t.length > 0 ? t : null;
}

function entitySummary(entity: Entity): {
  entityId: string;
  type: string;
  preferredName: string;
} {
  return {
    entityId: entity.entityId,
    type: entity.type,
    preferredName: entity.preferredName,
  };
}

const ENTITY_KINDS_DEFAULT = "person";

export const entityAction: Action = {
  name: RELATIONSHIPS_ACTION_NAME,
  similes: ["ENTITY_CRUD", "GRAPH_ENTITY", "KNOWLEDGE_GRAPH_CRUD"],
  description:
    "Direct CRUD over the runtime knowledge graph (entities + typed edges): create | read | list | log_interaction | set_identity | set_relationship | merge. Backs the relationships viewer. Contact orchestration with planning -> ENTITY (personal-assistant).",
  descriptionCompressed:
    "KNOWLEDGE_GRAPH create|read|list|log_interaction|set_identity|set_relationship|merge",
  tags: [
    "domain:relationships",
    "capability:read",
    "capability:write",
    "capability:update",
    "capability:delete",
    "surface:internal",
  ],
  contexts: [...RELATIONSHIPS_CONTEXTS],
  contextGate: { anyOf: [...RELATIONSHIPS_CONTEXTS] },
  roleGate: { minRole: "OWNER" },
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    if (!resolveKnowledgeGraphService(runtime)) return false;
    return hasOwnerAccess(runtime, message);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    options: HandlerOptions | undefined,
    callback: HandlerCallback | undefined,
  ): Promise<ActionResult> => {
    if (!(await hasOwnerAccess(runtime, message))) {
      const text = "The knowledge graph is restricted to the owner.";
      await callback?.({
        text,
        source: "action",
        action: RELATIONSHIPS_ACTION_NAME,
      });
      return { success: false, text, data: { error: "PERMISSION_DENIED" } };
    }

    const service = resolveKnowledgeGraphService(runtime);
    if (!service) {
      const text = "The knowledge graph service is not available.";
      await callback?.({
        text,
        source: "action",
        action: RELATIONSHIPS_ACTION_NAME,
      });
      return { success: false, text, data: { error: "SERVICE_UNAVAILABLE" } };
    }

    const params = getParams(options);
    const op = resolveOp(params);
    if (!op) {
      const text =
        "Tell me which knowledge-graph op: create, read, list, log_interaction, set_identity, set_relationship, or merge.";
      await callback?.({
        text,
        source: "action",
        action: RELATIONSHIPS_ACTION_NAME,
      });
      return { success: false, text, data: { error: "MISSING_OP" } };
    }

    const entityStore = service.getEntityStore();
    const relationshipStore = service.getRelationshipStore();

    const reply = async (
      result: ActionResult & { text: string },
    ): Promise<ActionResult> => {
      await callback?.({
        text: result.text,
        source: "action",
        action: RELATIONSHIPS_ACTION_NAME,
      });
      return result;
    };

    logger.info(
      `${RELATIONSHIPS_LOG_PREFIX} ${RELATIONSHIPS_ACTION_NAME} op=${op}`,
    );

    switch (op) {
      case "create": {
        const name = trimmed(params.name);
        if (!name) {
          return reply({
            success: false,
            text: "I need a display name to create an entity.",
            data: { op, error: "MISSING_FIELDS" },
          });
        }
        const kind = trimmed(params.kind) ?? ENTITY_KINDS_DEFAULT;
        const entity = await entityStore.upsert({
          type: kind,
          preferredName: name,
          identities: [],
          tags: [],
          visibility: "owner_agent_admin",
          state: {},
        });
        return reply({
          success: true,
          text: `Created ${kind} "${entity.preferredName}" (${entity.entityId}).`,
          data: { op, entity: entitySummary(entity) },
        });
      }

      case "read": {
        const entityId = trimmed(params.entityId);
        if (!entityId) {
          return reply({
            success: false,
            text: "I need an entityId to read.",
            data: { op, error: "MISSING_FIELDS" },
          });
        }
        const entity = await entityStore.get(entityId);
        if (!entity) {
          return reply({
            success: false,
            text: `No entity found with id ${entityId}.`,
            data: { op, error: "NOT_FOUND", entityId },
          });
        }
        return reply({
          success: true,
          text: `${entity.preferredName} (${entity.type}) — ${entity.identities.length} identit${entity.identities.length === 1 ? "y" : "ies"}.`,
          data: { op, entity },
        });
      }

      case "list": {
        const kind = trimmed(params.kind);
        const limit =
          typeof params.limit === "number" && params.limit > 0
            ? Math.floor(params.limit)
            : 50;
        const entities = await entityStore.list({
          ...(kind ? { type: kind } : {}),
          limit,
        });
        return reply({
          success: true,
          text:
            entities.length === 0
              ? "No entities in the graph yet."
              : `${entities.length} entit${entities.length === 1 ? "y" : "ies"} in the graph.`,
          data: { op, entities: entities.map(entitySummary) },
        });
      }

      case "log_interaction": {
        const entityId = trimmed(params.entityId);
        if (!entityId) {
          return reply({
            success: false,
            text: "I need an entityId to log an interaction.",
            data: { op, error: "MISSING_FIELDS" },
          });
        }
        const entity = await entityStore.get(entityId);
        if (!entity) {
          return reply({
            success: false,
            text: `No entity found with id ${entityId}.`,
            data: { op, error: "NOT_FOUND", entityId },
          });
        }
        const platform =
          trimmed(params.platform) ??
          entity.state.lastInteractionPlatform ??
          "unknown";
        const direction =
          params.direction === "inbound" ? "inbound" : "outbound";
        await entityStore.recordInteraction(entityId, {
          platform,
          direction,
          summary: trimmed(params.summary) ?? "",
          occurredAt: new Date().toISOString(),
        });
        return reply({
          success: true,
          text: `Logged ${direction} interaction with ${entity.preferredName} on ${platform}.`,
          data: { op, entityId, platform, direction },
        });
      }

      case "set_identity": {
        const platform = trimmed(params.platform);
        const handle = trimmed(params.handle);
        if (!platform || !handle) {
          return reply({
            success: false,
            text: "I need both the platform and the handle to record an identity.",
            data: { op, error: "MISSING_FIELDS" },
          });
        }
        const evidence = trimmed(params.evidence) ?? "user_chat";
        const displayName = trimmed(params.displayName);
        const observation = await entityStore.observeIdentity({
          platform,
          handle,
          ...(displayName ? { displayName } : {}),
          evidence: [evidence],
          confidence: 1,
        });
        // User-asserted identities are verified — mark this (platform, handle).
        const verifiedIdentities: EntityIdentity[] =
          observation.entity.identities.map((identity) =>
            identity.platform === platform && identity.handle === handle
              ? { ...identity, verified: true }
              : identity,
          );
        const merged = await entityStore.upsert({
          ...observation.entity,
          identities: verifiedIdentities,
        });
        return reply({
          success: true,
          text: `Recorded identity ${platform}:${handle} on ${merged.preferredName}.`,
          data: {
            op,
            entity: entitySummary(merged),
            mergedFrom: observation.mergedFrom ?? null,
            conflict: observation.conflict ?? false,
          },
        });
      }

      case "set_relationship": {
        const toEntityId = trimmed(params.toEntityId);
        const relationshipType = trimmed(params.relationshipType);
        if (!toEntityId || !relationshipType) {
          return reply({
            success: false,
            text: "I need the target entity id and the relationship type (e.g. manages, colleague_of, works_at).",
            data: { op, error: "MISSING_FIELDS" },
          });
        }
        const fromEntityId = trimmed(params.fromEntityId) ?? SELF_ENTITY_ID;
        const evidence = trimmed(params.evidence) ?? "user_chat";
        const edge = await relationshipStore.upsert({
          fromEntityId,
          toEntityId,
          type: relationshipType,
          metadata: {},
          state: {},
          evidence: [evidence],
          confidence: 1,
          source: "user_chat",
        });
        return reply({
          success: true,
          text: `Recorded ${fromEntityId} -[${relationshipType}]-> ${toEntityId}.`,
          data: { op, relationship: edge },
        });
      }

      case "merge": {
        const targetEntityId = trimmed(params.entityId);
        const sourceEntityIds = (params.sourceEntityIds ?? []).filter(
          (id): id is string => typeof id === "string" && id.trim().length > 0,
        );
        if (!targetEntityId || sourceEntityIds.length === 0) {
          return reply({
            success: false,
            text: "I need a target entityId and at least one sourceEntityId to merge duplicates.",
            data: { op, error: "MISSING_FIELDS" },
          });
        }
        const merged = await entityStore.merge(targetEntityId, sourceEntityIds);
        return reply({
          success: true,
          text: `Merged ${sourceEntityIds.length} entit${sourceEntityIds.length === 1 ? "y" : "ies"} into ${merged.preferredName}.`,
          data: {
            op,
            entity: entitySummary(merged),
            sourceEntityIds,
          },
        });
      }
    }
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Add Alice as a person to my graph." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Created person "Alice".',
          action: RELATIONSHIPS_ACTION_NAME,
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Pat is my manager." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Recorded self -[manages]-> Pat.",
          action: RELATIONSHIPS_ACTION_NAME,
        },
      },
    ],
  ],
};

export default entityAction;
