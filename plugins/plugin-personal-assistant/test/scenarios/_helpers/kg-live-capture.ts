/**
 * Live read-back predicates for the Pack H2 knowledge-graph capture scenarios.
 *
 * Pack H2's whole point is to prove that a conversational capture lands as a
 * real persisted primitive, not that the ENTITY action was called with the
 * arguments the scenario itself supplied (that is tautological — the runner
 * records the scripted `options` verbatim, so a `selectedActionArguments` check
 * passes even when the action no-ops). These predicates instead resolve the
 * runtime-owned {@link KnowledgeGraphService} (`eliza_knowledge_graph`,
 * `packages/agent/src/services/knowledge-graph/service.ts`) off `ctx.runtime`
 * and read the row back through the SAME per-agent store the ENTITY action
 * wrote to (`RelationshipStore` / `EntityStore`, `app_lifeops.*` tables) — no
 * mock, no route stub. A predicate returns `undefined` to pass and a diagnostic
 * string to fail, per the scenario-runner `custom` final-check contract.
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";

/** Registered service type; mirrors `KNOWLEDGE_GRAPH_SERVICE` in @elizaos/agent. */
const KNOWLEDGE_GRAPH_SERVICE = "eliza_knowledge_graph";

interface RelationshipRowLike {
  fromEntityId: string;
  toEntityId: string;
  type: string;
  evidence: string[];
  confidence: number;
  status: string;
}

interface RelationshipStoreLike {
  list(filter?: {
    fromEntityId?: string;
    toEntityId?: string;
    type?: string | string[];
    includeRetired?: boolean;
  }): Promise<RelationshipRowLike[]>;
}

interface EntityIdentityLike {
  platform: string;
  handle: string;
}

interface EntityRowLike {
  entityId: string;
  preferredName: string;
  identities: EntityIdentityLike[];
}

interface EntityStoreLike {
  get(entityId: string): Promise<EntityRowLike | null>;
  upsert(input: {
    entityId?: string;
    type: string;
    preferredName: string;
    fullName?: string;
    identities: EntityIdentityLike[];
    state: Record<string, unknown>;
    tags: string[];
    visibility: string;
  }): Promise<EntityRowLike>;
}

interface KnowledgeGraphServiceLike {
  getRelationshipStore(agentId?: string): RelationshipStoreLike;
  getEntityStore(agentId?: string): EntityStoreLike;
}

interface RuntimeLike {
  agentId: string;
  getService(type: string): KnowledgeGraphServiceLike | null;
}

type Resolved = { runtime: RuntimeLike; kg: KnowledgeGraphServiceLike };

function resolveGraph(ctx: ScenarioContext): Resolved | string {
  const runtime = ctx.runtime as RuntimeLike | undefined;
  if (!runtime || typeof runtime.getService !== "function") {
    return "scenario runtime is missing getService — cannot read the knowledge graph";
  }
  const kg = runtime.getService(KNOWLEDGE_GRAPH_SERVICE);
  if (!kg || typeof kg.getRelationshipStore !== "function") {
    return "KnowledgeGraphService is not registered on the scenario runtime";
  }
  return { runtime, kg };
}

/**
 * Assert an active typed edge `from -[type]-> to` is persisted, optionally
 * carrying each of `evidenceIncludes` as a substring of some evidence entry.
 * Reads the real `RelationshipStore.list` (active-only by default).
 */
export function relationshipEdgePersisted(opts: {
  fromEntityId?: string;
  toEntityId: string;
  type: string;
  evidenceIncludes?: string[];
}) {
  return async (ctx: ScenarioContext): Promise<string | undefined> => {
    const resolved = resolveGraph(ctx);
    if (typeof resolved === "string") return resolved;
    const store = resolved.kg.getRelationshipStore(resolved.runtime.agentId);
    const from = opts.fromEntityId ?? "self";
    const edges = await store.list({
      fromEntityId: from,
      toEntityId: opts.toEntityId,
      type: opts.type,
    });
    if (edges.length < 1) {
      const anyToTarget = await store.list({ toEntityId: opts.toEntityId });
      return `expected a persisted ${opts.type} edge ${from} -> ${opts.toEntityId}, but RelationshipStore returned none. Edges to ${opts.toEntityId}: ${JSON.stringify(anyToTarget.map((e) => `${e.type}(${e.status})`))}`;
    }
    if (opts.evidenceIncludes && opts.evidenceIncludes.length > 0) {
      const allEvidence = edges.flatMap((e) => e.evidence ?? []);
      for (const needle of opts.evidenceIncludes) {
        if (!allEvidence.some((entry) => entry.includes(needle))) {
          return `persisted ${opts.type} edge to ${opts.toEntityId} is missing evidence "${needle}"; stored evidence: ${JSON.stringify(allEvidence)}`;
        }
      }
    }
    return undefined;
  };
}

/**
 * Assert an entity id resolves in the store and preferred name matches. Used to
 * prove a merge kept the surviving (target) node.
 */
export function entityPersisted(opts: {
  entityId: string;
  preferredNameIncludes?: string;
}) {
  return async (ctx: ScenarioContext): Promise<string | undefined> => {
    const resolved = resolveGraph(ctx);
    if (typeof resolved === "string") return resolved;
    const store = resolved.kg.getEntityStore(resolved.runtime.agentId);
    const entity = await store.get(opts.entityId);
    if (!entity)
      return `expected entity ${opts.entityId} to be persisted, store returned null`;
    if (
      opts.preferredNameIncludes &&
      !entity.preferredName
        .toLowerCase()
        .includes(opts.preferredNameIncludes.toLowerCase())
    ) {
      return `entity ${opts.entityId} preferredName "${entity.preferredName}" does not include "${opts.preferredNameIncludes}"`;
    }
    return undefined;
  };
}

/** Assert an entity id no longer resolves — proves a merge collapsed the source. */
export function entityAbsent(entityId: string) {
  return async (ctx: ScenarioContext): Promise<string | undefined> => {
    const resolved = resolveGraph(ctx);
    if (typeof resolved === "string") return resolved;
    const store = resolved.kg.getEntityStore(resolved.runtime.agentId);
    const entity = await store.get(entityId);
    if (entity) {
      return `expected entity ${entityId} to be gone after merge, but it is still persisted as "${entity.preferredName}"`;
    }
    return undefined;
  };
}

/**
 * Seed a bare entity node directly through the real EntityStore. Used by the
 * merge scenario to stand up the duplicate rows the ENTITY merge subaction then
 * collapses — the merge engine requires the target + sources to pre-exist
 * (`EntityStore.merge` throws on a missing target).
 */
export function seedEntity(input: {
  entityId: string;
  type: string;
  preferredName: string;
  identities?: EntityIdentityLike[];
}) {
  return async (ctx: ScenarioContext): Promise<string | undefined> => {
    const resolved = resolveGraph(ctx);
    if (typeof resolved === "string") return resolved;
    const store = resolved.kg.getEntityStore(resolved.runtime.agentId);
    await store.upsert({
      entityId: input.entityId,
      type: input.type,
      preferredName: input.preferredName,
      identities: input.identities ?? [],
      state: {},
      tags: [],
      visibility: "owner_agent_admin",
    });
    return undefined;
  };
}
