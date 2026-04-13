/**
 * Eliza Handler — LLM-based extraction via a real AgentRuntime.
 *
 * This handler creates a real Eliza AgentRuntime with:
 *   - An in-memory database (enhanced for components/relationships/entities)
 *   - The plugin-rolodex (evaluator, services)
 *   - The plugin-openai (model handlers for LLM calls)
 *
 * For each conversation, it:
 *   1. Creates entities & a room
 *   2. Stores messages as memories
 *   3. Invokes the relationshipExtractionEvaluator on the last message
 *   4. Maps the LLM extraction back to the benchmark Extraction format
 *
 * Resolution uses the same signal-based approach as the rolodex handler
 * but operates on LLM-extracted data instead of regex-extracted data.
 */

import type {
  Handler,
  Conversation,
  GroundTruthWorld,
  Extraction,
  Resolution,
} from '../types';

import { AgentRuntime } from '../../../eliza/packages/typescript/src/runtime';
import { InMemoryDatabaseAdapter } from '../../../eliza/packages/typescript/src/database/inMemoryAdapter';
import type {
  Entity,
  Component,
  Memory,
  Relationship,
  UUID,
  Character,
  MetadataValue,
  Plugin,
  IAgentRuntime,
} from '../../../eliza/packages/typescript/src/types';
import { stringToUuid } from '../../../eliza/packages/typescript/src/utils';
import { ChannelType } from '../../../eliza/packages/typescript/src/types/primitives';

import { relationshipExtractionEvaluator } from '../../../plugins/plugin-rolodex/typescript/src/evaluators/relationshipExtraction';
import { rolodexPlugin } from '../../../plugins/plugin-rolodex/typescript/src/index';
import { openaiPlugin } from '../../../plugins/plugin-openai/typescript/index';

import type {
  ExtractionResult,
  ResolutionSignal,
  ResolutionSignalType,
} from '../../../plugins/plugin-rolodex/typescript/src/types/index';
import { SIGNAL_WEIGHTS, RESOLUTION_THRESHOLDS } from '../../../plugins/plugin-rolodex/typescript/src/types/index';
import { normalizeHandle } from '../../../plugins/plugin-rolodex/typescript/src/utils/similarity';

// ──────────────────────────────────────────────
// Enhanced In-Memory Adapter
// ──────────────────────────────────────────────

/**
 * Extends the base InMemoryDatabaseAdapter with working implementations
 * for components, relationships, and per-room entity tracking — all of
 * which the rolodex evaluator needs but the base adapter stubs out.
 */
class BenchmarkAdapter extends InMemoryDatabaseAdapter {
  private componentStore = new Map<string, Component>();
  private entityComponents = new Map<string, Set<string>>();
  private relationshipStore = new Map<string, Relationship>();
  private entityRelationships = new Map<string, Set<string>>();
  private roomEntities = new Map<string, Set<string>>();
  private entityStore = new Map<string, Entity>();

  override async createEntities(entities: Entity[]): Promise<boolean> {
    for (const e of entities) {
      if (e.id) {
        this.entityStore.set(String(e.id), e);
      }
    }
    return super.createEntities(entities);
  }

  override async updateEntity(entity: Entity): Promise<void> {
    if (entity.id) {
      this.entityStore.set(String(entity.id), entity);
    }
    return super.updateEntity(entity);
  }

  override async getEntitiesByIds(entityIds: UUID[]): Promise<Entity[] | null> {
    const out: Entity[] = [];
    for (const id of entityIds) {
      const e = this.entityStore.get(String(id));
      if (e) out.push(e);
    }
    return out.length > 0 ? out : await super.getEntitiesByIds(entityIds);
  }

  override async getEntitiesForRoom(roomId: UUID, _includeComponents?: boolean): Promise<Entity[]> {
    const entityIds = this.roomEntities.get(String(roomId));
    if (!entityIds || entityIds.size === 0) return [];
    const entities: Entity[] = [];
    for (const eid of entityIds) {
      const entity = this.entityStore.get(eid);
      if (entity) {
        if (_includeComponents) {
          const components = await this.getComponents(eid as UUID);
          entities.push({ ...entity, components });
        } else {
          entities.push(entity);
        }
      }
    }
    return entities;
  }

  override async addParticipantsRoom(entityIds: UUID[], roomId: UUID): Promise<boolean> {
    const roomKey = String(roomId);
    const set = this.roomEntities.get(roomKey) ?? new Set<string>();
    for (const eid of entityIds) {
      set.add(String(eid));
    }
    this.roomEntities.set(roomKey, set);
    return super.addParticipantsRoom(entityIds, roomId);
  }

  override async createComponent(component: Component): Promise<boolean> {
    const id = component.id ?? crypto.randomUUID();
    const stored = { ...component, id: id as UUID };
    this.componentStore.set(String(id), stored);
    const entityId = String(component.entityId);
    const set = this.entityComponents.get(entityId) ?? new Set<string>();
    set.add(String(id));
    this.entityComponents.set(entityId, set);
    return true;
  }

  override async getComponents(entityId: UUID, _worldId?: UUID, _sourceEntityId?: UUID): Promise<Component[]> {
    const componentIds = this.entityComponents.get(String(entityId));
    if (!componentIds) return [];
    const components: Component[] = [];
    for (const cid of componentIds) {
      const c = this.componentStore.get(cid);
      if (c) components.push(c);
    }
    return components;
  }

  override async getComponent(entityId: UUID, type: string, _worldId?: UUID, _sourceEntityId?: UUID): Promise<Component | null> {
    const componentIds = this.entityComponents.get(String(entityId));
    if (!componentIds) return null;
    for (const cid of componentIds) {
      const c = this.componentStore.get(cid);
      if (c && c.type === type) return c;
    }
    return null;
  }

  override async updateComponent(component: Component): Promise<void> {
    if (component.id) {
      this.componentStore.set(String(component.id), component);
    }
  }

  override async deleteComponent(componentId: UUID): Promise<void> {
    const component = this.componentStore.get(String(componentId));
    if (component) {
      const entityId = String(component.entityId);
      const set = this.entityComponents.get(entityId);
      if (set) {
        set.delete(String(componentId));
      }
      this.componentStore.delete(String(componentId));
    }
  }

  override async createRelationship(params: {
    sourceEntityId: UUID;
    targetEntityId: UUID;
    tags?: string[];
    metadata?: Record<string, MetadataValue>;
  }): Promise<boolean> {
    const id = crypto.randomUUID() as UUID;
    const rel: Relationship = {
      id,
      sourceEntityId: params.sourceEntityId,
      targetEntityId: params.targetEntityId,
      tags: params.tags ?? [],
      metadata: params.metadata ?? {},
      createdAt: new Date().toISOString(),
    };
    this.relationshipStore.set(String(id), rel);

    const srcKey = String(params.sourceEntityId);
    const tgtKey = String(params.targetEntityId);
    const srcSet = this.entityRelationships.get(srcKey) ?? new Set<string>();
    const tgtSet = this.entityRelationships.get(tgtKey) ?? new Set<string>();
    srcSet.add(String(id));
    tgtSet.add(String(id));
    this.entityRelationships.set(srcKey, srcSet);
    this.entityRelationships.set(tgtKey, tgtSet);
    return true;
  }

  override async updateRelationship(relationship: Relationship): Promise<void> {
    if (relationship.id) {
      this.relationshipStore.set(String(relationship.id), relationship);
    }
  }

  override async getRelationships(params: { entityId: UUID }): Promise<Relationship[]> {
    const relIds = this.entityRelationships.get(String(params.entityId));
    if (!relIds) return [];
    const rels: Relationship[] = [];
    for (const rid of relIds) {
      const r = this.relationshipStore.get(rid);
      if (r) rels.push(r);
    }
    return rels;
  }
}

// ──────────────────────────────────────────────
// Handler State
// ──────────────────────────────────────────────

let runtime: AgentRuntime | null = null;

const AGENT_CHARACTER: Character = {
  name: 'RolodexAgent',
  username: 'rolodex_agent',
  bio: ['An agent that extracts identities, relationships, and trust signals from conversations'],
  system: 'You are an expert at analyzing conversations to extract structured information about people\'s identities, relationships, and trust signals.',
  templates: {},
  messageExamples: [],
  postExamples: [],
  topics: [],
  adjectives: [],
  knowledge: [],
  plugins: [],
  secrets: {},
};

// ──────────────────────────────────────────────
// Name → Entity ID Mapping
// ──────────────────────────────────────────────

/** Build a display-name → entity-ID map from a conversation's messages. */
function buildNameMap(conv: Conversation): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of conv.messages) {
    map.set(msg.displayName.toLowerCase(), msg.from);
  }
  return map;
}

/** Resolve an LLM-produced name to a benchmark entity ID. */
function resolveName(name: string, nameMap: Map<string, string>): string | null {
  const lower = name.toLowerCase().trim();
  // Exact match
  const exact = nameMap.get(lower);
  if (exact) return exact;
  // Partial match (name contains or is contained)
  for (const [displayName, entityId] of nameMap) {
    if (displayName.includes(lower) || lower.includes(displayName)) {
      return entityId;
    }
  }
  return null;
}

// ──────────────────────────────────────────────
// Handler Implementation
// ──────────────────────────────────────────────

export const elizaHandler: Handler = {
  name: 'Eliza (LLM)',

  async setup(): Promise<void> {
    const adapter = new BenchmarkAdapter();
    runtime = new AgentRuntime({
      character: AGENT_CHARACTER,
      plugins: [
        rolodexPlugin as Plugin,
        openaiPlugin as Plugin,
      ],
      adapter,
      logLevel: 'warn',
      checkShouldRespond: false,
    });
    await runtime.initialize({ allowNoDatabase: true });
  },

  async teardown(): Promise<void> {
    if (runtime) {
      await runtime.stop();
      runtime = null;
    }
  },

  async extract(conv: Conversation, _world: GroundTruthWorld): Promise<Extraction> {
    if (!runtime) throw new Error('Eliza handler not initialized — call setup() first');
    const start = performance.now();
    const traces: string[] = [];
    const nameMap = buildNameMap(conv);

    // 1. Create a room for this conversation
    const roomId = stringToUuid(`bench-room-${conv.id}`) as UUID;
    await runtime.createRoom({
      id: roomId,
      name: conv.name,
      type: ChannelType.GROUP,
      source: conv.platform,
      worldId: stringToUuid(`bench-world`) as UUID,
    });

    // 2. Create entities for each unique participant
    const participantIds = [...new Set(conv.messages.map(m => m.from))];
    const entityUuids: UUID[] = [];
    for (const pid of participantIds) {
      const displayName = conv.messages.find(m => m.from === pid)?.displayName ?? pid;
      const entityId = stringToUuid(`bench-entity-${pid}`) as UUID;
      entityUuids.push(entityId);

      // Create entity if it doesn't exist yet
      const existing = await runtime.getEntityById(entityId);
      if (!existing) {
        await runtime.createEntity({
          id: entityId,
          names: [displayName],
          agentId: runtime.agentId,
          metadata: {},
        });
        traces.push(`[SETUP] Created entity ${displayName} (${pid})`);
      }
    }

    // 3. Add all participants (and the agent) to the room
    await runtime.adapter.addParticipantsRoom([...entityUuids, runtime.agentId], roomId);

    // 4. Store each message as a memory
    for (let i = 0; i < conv.messages.length; i++) {
      const msg = conv.messages[i];
      const entityId = stringToUuid(`bench-entity-${msg.from}`) as UUID;
      const memoryId = stringToUuid(`bench-msg-${conv.id}-${i}`) as UUID;
      await runtime.createMemory(
        {
          id: memoryId,
          entityId,
          roomId,
          content: {
            type: 'text' as const,
            text: msg.text,
            source: conv.platform,
          },
          createdAt: Date.now() - (conv.messages.length - i) * 1000,
        },
        'messages',
      );
    }

    // 5. Invoke the relationship extraction evaluator on the last message
    const lastMsg = conv.messages[conv.messages.length - 1];
    const lastEntityId = stringToUuid(`bench-entity-${lastMsg.from}`) as UUID;
    const lastMemoryId = stringToUuid(`bench-msg-${conv.id}-${conv.messages.length - 1}`) as UUID;
    const lastMemory: Memory = {
      id: lastMemoryId,
      entityId: lastEntityId,
      roomId,
      content: { type: 'text', text: lastMsg.text, source: conv.platform },
      createdAt: Date.now(),
    };

    let extraction: ExtractionResult | null = null;
    try {
      const result = await relationshipExtractionEvaluator.handler(
        runtime as IAgentRuntime,
        lastMemory,
        undefined,
      );
      if (result && typeof result === 'object' && 'data' in result) {
        const data = (result as { data?: { extraction?: ExtractionResult } }).data;
        if (data?.extraction) {
          extraction = data.extraction;
        }
      }
      traces.push(`[LLM] Evaluator returned: ${extraction ? 'extraction data' : 'no data'}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      traces.push(`[LLM] Evaluator error: ${errMsg}`);
    }

    // 6. Map LLM extraction → benchmark Extraction format
    const identities: Extraction['identities'] = [];
    const relationships: Extraction['relationships'] = [];
    const trustSignals: Extraction['trustSignals'] = [];

    if (extraction) {
      // Identities
      if (Array.isArray(extraction.platformIdentities)) {
        for (const pi of extraction.platformIdentities) {
          if (!pi.platform || !pi.handle || !pi.belongsTo) continue;
          const entityId = resolveName(pi.belongsTo, nameMap);
          if (entityId) {
            identities.push({
              entityId,
              platform: pi.platform.toLowerCase(),
              handle: pi.handle,
            });
            traces.push(`[MAP] Identity: ${pi.belongsTo} → ${entityId} [${pi.platform}:${pi.handle}]`);
          } else {
            traces.push(`[MAP] Could not resolve name '${pi.belongsTo}' for identity ${pi.platform}:${pi.handle}`);
          }
        }
      }

      // Relationships
      if (Array.isArray(extraction.relationships)) {
        for (const rel of extraction.relationships) {
          const entityA = resolveName(rel.personA, nameMap);
          const entityB = resolveName(rel.personB, nameMap);
          if (entityA && entityB && entityA !== entityB) {
            relationships.push({
              entityA,
              entityB,
              type: rel.type ?? 'community',
              sentiment: rel.sentiment ?? 'positive',
            });
            traces.push(`[MAP] Relationship: ${rel.personA}(${entityA}) <-> ${rel.personB}(${entityB}) [${rel.type}]`);
          }
        }
      }

      // Trust Signals
      if (Array.isArray(extraction.trustSignals)) {
        for (const ts of extraction.trustSignals) {
          if (ts.signal === 'suspicious' || ts.signal === 'deceptive') {
            const entityId = resolveName(ts.entityName, nameMap);
            if (entityId) {
              trustSignals.push({ entityId, signal: 'suspicious' });
              traces.push(`[MAP] Trust: ${ts.entityName} → ${entityId} [suspicious]`);
            }
          }
        }
      }
    }

    // Deduplicate identities
    const seenIds = new Set<string>();
    const uniqueIdentities = identities.filter(i => {
      const key = `${i.entityId}:${i.platform}:${normalizeHandle(i.handle)}`;
      if (seenIds.has(key)) return false;
      seenIds.add(key);
      return true;
    });

    return {
      conversationId: conv.id,
      identities: uniqueIdentities,
      relationships,
      trustSignals,
      traces,
      wallTimeMs: performance.now() - start,
    };
  },

  resolve(extractions: Extraction[], world: GroundTruthWorld): Resolution {
    // Resolution uses the same signal-based approach as the rolodex handler
    // but operates on LLM-extracted identities rather than regex-extracted ones.
    const start = performance.now();
    const traces: string[] = [];

    // Collect extracted identities per entity
    const entityExtracted = new Map<string, Array<{ platform: string; handle: string }>>();
    for (const ext of extractions) {
      for (const id of ext.identities) {
        const arr = entityExtracted.get(id.entityId) ?? [];
        if (!arr.some(x => x.platform === id.platform && normalizeHandle(x.handle) === normalizeHandle(id.handle))) {
          arr.push({ platform: id.platform, handle: id.handle });
        }
        entityExtracted.set(id.entityId, arr);
      }
    }

    traces.push(`Entities with extracted identities: ${entityExtracted.size}`);
    for (const [eid, ids] of entityExtracted) {
      traces.push(`  ${eid}: ${ids.map(i => `${i.platform}:${i.handle}`).join(', ')}`);
    }

    // Build platform handle index from the world
    const platformIndex = new Map<string, string>();
    for (const entity of world.entities) {
      const key = `${entity.platform}:${normalizeHandle(entity.platformHandle)}`;
      platformIndex.set(key, entity.id);
    }
    traces.push(`Platform handle index: ${platformIndex.size} entries`);

    // Compare extracted identities against world entity platform handles
    const links: Resolution['links'] = [];
    const proposedPairs = new Set<string>();

    for (const [entityId, extracted] of entityExtracted) {
      for (const ext of extracted) {
        const key = `${ext.platform}:${normalizeHandle(ext.handle)}`;
        const matchedEntityId = platformIndex.get(key);

        if (matchedEntityId && matchedEntityId !== entityId) {
          const pairKey = [entityId, matchedEntityId].sort().join(':');
          if (proposedPairs.has(pairKey)) continue;
          proposedPairs.add(pairKey);

          const signals: ResolutionSignal[] = [{
            type: 'self_identification' as ResolutionSignalType,
            weight: 0.95,
            evidence: `${entityId} extracted ${ext.platform}:${ext.handle} matching ${matchedEntityId}'s platform handle`,
            timestamp: Date.now(),
          }];

          const score = scoreSignals(signals);
          traces.push(`Pair ${entityId} <-> ${matchedEntityId}: score=${score.toFixed(3)} via ${ext.platform}:${ext.handle}`);

          if (score >= RESOLUTION_THRESHOLDS.PROPOSE) {
            links.push({
              entityA: entityId, entityB: matchedEntityId, confidence: score,
              signals: signals.map(s => `[${s.type}] ${s.evidence}`),
            });
            traces.push(`  → PROPOSED LINK`);
          }
        }
      }
    }

    // Compare extracted handles across different entities (shared handle = same person)
    const entityIds = [...entityExtracted.keys()];
    for (let i = 0; i < entityIds.length; i++) {
      for (let j = i + 1; j < entityIds.length; j++) {
        const a = entityIds[i];
        const b = entityIds[j];
        const pairKey = [a, b].sort().join(':');
        if (proposedPairs.has(pairKey)) continue;

        const idsA = entityExtracted.get(a) ?? [];
        const idsB = entityExtracted.get(b) ?? [];
        const signals: ResolutionSignal[] = [];

        for (const idA of idsA) {
          for (const idB of idsB) {
            if (idA.platform === idB.platform && normalizeHandle(idA.handle) === normalizeHandle(idB.handle)) {
              signals.push({
                type: 'self_identification' as ResolutionSignalType,
                weight: 0.95,
                evidence: `Both ${a} and ${b} have extracted ${idA.platform}:${idA.handle}`,
                timestamp: Date.now(),
              });
            }
          }
        }

        if (signals.length > 0) {
          const score = scoreSignals(signals);
          traces.push(`Pair ${a} <-> ${b}: score=${score.toFixed(3)} via shared extracted handles`);

          if (score >= RESOLUTION_THRESHOLDS.PROPOSE) {
            proposedPairs.add(pairKey);
            links.push({
              entityA: a, entityB: b, confidence: score,
              signals: signals.map(s => `[${s.type}] ${s.evidence}`),
            });
            traces.push(`  → PROPOSED LINK`);
          } else {
            traces.push(`  → Below threshold`);
          }
        }
      }
    }

    return { links, traces, wallTimeMs: performance.now() - start };
  },
};

// ── Helpers ──────────────────────────────────

function scoreSignals(signals: ResolutionSignal[]): number {
  if (signals.length === 0) return 0;
  const byType = new Map<ResolutionSignalType, ResolutionSignal[]>();
  for (const s of signals) {
    const g = byType.get(s.type) ?? [];
    g.push(s);
    byType.set(s.type, g);
  }
  let total = 0;
  for (const [type, sigs] of byType) {
    const w = SIGNAL_WEIGHTS[type] ?? 0.1;
    const sorted = sigs.sort((a, b) => b.weight - a.weight);
    let ts = sorted[0].weight * w;
    for (let i = 1; i < sorted.length; i++) ts += sorted[i].weight * w * Math.pow(0.3, i);
    total += ts;
  }
  return Math.max(0, Math.min(1, total));
}
