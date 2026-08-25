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
 *   - `set_relationship`   upsert a typed edge between two entities
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
import { describeUserReference, logger } from "@elizaos/core";
import type { Entity } from "@elizaos/shared";
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
  /** Target entity id for `read` / `log_interaction`. */
  entityId?: string;
  /** Connector platform for `log_interaction`. */
  platform?: string;
  /** Edge target id for `set_relationship`. */
  toEntityId?: string;
  /** Edge source id for `set_relationship`. Defaults to `self`. */
  fromEntityId?: string;
  /** Edge type label for `set_relationship` (e.g. `manages`). */
  relationshipType?: string;
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

function entityCount(count: number, hasMore: boolean): string {
  return `${count}${hasMore ? "+" : ""} entit${count === 1 && !hasMore ? "y" : "ies"}`;
}

function listScopeText(args: {
  entities: readonly Entity[];
  kind: string | null;
  limit: number;
  hasMore: boolean;
  unfiltered: { count: number; hasMore: boolean } | null;
}): string {
  const kindLabel = args.kind
    ? describeUserReference(args.kind, "that entity kind")
    : null;
  if (args.entities.length > 0) {
    const scope = kindLabel ? ` of kind ${kindLabel}` : "";
    const cap = args.hasMore
      ? ` (capped at ${args.limit}; raise limit to see more)`
      : "";
    return `${entityCount(args.entities.length, args.hasMore)}${scope} in the graph${cap}.`;
  }
  if (!kindLabel) return "No entities in the graph yet.";
  if (!args.unfiltered || args.unfiltered.count === 0) {
    return `No entities of kind ${kindLabel}; the graph has no entities of any kind yet.`;
  }
  return `No entities of kind ${kindLabel}. The graph has ${entityCount(args.unfiltered.count, args.unfiltered.hasMore)} of other kinds; list without kind to see them.`;
}

export const entityAction: Action = {
  name: RELATIONSHIPS_ACTION_NAME,
  similes: ["ENTITY_CRUD", "GRAPH_ENTITY", "KNOWLEDGE_GRAPH_CRUD"],
  description:
    "Direct CRUD over the runtime knowledge graph (entities + typed edges): create | read | list | log_interaction | set_relationship. Identity claims and merges require the deterministic identity authority and are not agent actions.",
  descriptionCompressed:
    "KNOWLEDGE_GRAPH create|read|list|log_interaction|set_relationship",
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
        "Tell me which knowledge-graph op: create, read, list, log_interaction, or set_relationship. Identity verification and merging require the deterministic identity authority.";
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
        const page = await entityStore.list({
          ...(kind ? { type: kind } : {}),
          limit: limit + 1,
        });
        const hasMore = page.length > limit;
        const entities = hasMore ? page.slice(0, limit) : page;
        const unfilteredPage =
          kind && entities.length === 0
            ? await entityStore.list({ limit: limit + 1 })
            : null;
        return reply({
          success: true,
          text: listScopeText({
            entities,
            kind,
            limit,
            hasMore,
            unfiltered: unfilteredPage
              ? {
                  count: Math.min(unfilteredPage.length, limit),
                  hasMore: unfilteredPage.length > limit,
                }
              : null,
          }),
          data: {
            op,
            entities: entities.map(entitySummary),
            kind,
            limit,
            hasMore,
          },
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
