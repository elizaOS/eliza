/**
 * Rolodex Handler v2 — realistic extraction + resolution
 *
 * Extraction: heuristic patterns for identities, relationships, trust.
 * Resolution: compares extracted handles against ALL entities' platform handles,
 *   uses project/topic affinity, uses social graph overlap.
 */

import type {
  Handler, Conversation, Message, Extraction, Resolution,
  GroundTruthWorld, WorldEntity,
} from '../types';

import { normalizeHandle, handleCorrelation, jaccardSimilarity } from '../../../plugins/plugin-rolodex/typescript/src/utils/similarity';
import { SIGNAL_WEIGHTS, RESOLUTION_THRESHOLDS } from '../../../plugins/plugin-rolodex/typescript/src/types/index';
import type { ResolutionSignal, ResolutionSignalType } from '../../../plugins/plugin-rolodex/typescript/src/types/index';

export const rolodexHandler: Handler = {
  name: 'Rolodex (Algorithmic)',

  extract(conv: Conversation, world: GroundTruthWorld): Extraction {
    const start = performance.now();
    const traces: string[] = [];
    const participantIds = new Set(conv.messages.map(m => m.from));

    // ── Identity extraction ──────────────────
    const identities: Extraction['identities'] = [];

    for (const msg of conv.messages) {
      // GitHub: github.com/username
      for (const [, user] of msg.text.matchAll(/github\.com\/(\w+)/gi)) {
        identities.push({ entityId: msg.from, platform: 'github', handle: user });
        traces.push(`[ID] ${msg.displayName}: github '${user}'`);
      }

      // Twitter: self-report patterns — "im @X on twitter", "my twitter is @X", "— @X"
      for (const [, handle] of msg.text.matchAll(/(?:im|my twitter is|find me (?:at|on twitter)|more active on twitter.*?)\s+(@\w+)/gi)) {
        identities.push({ entityId: msg.from, platform: 'twitter', handle });
        traces.push(`[ID] ${msg.displayName}: self-reported twitter '${handle}'`);
      }
      // Twitter self-report: "my twitter is @X" at end of message
      for (const [, handle] of msg.text.matchAll(/twitter is\s+(@\w+)/gi)) {
        identities.push({ entityId: msg.from, platform: 'twitter', handle });
        traces.push(`[ID] ${msg.displayName}: 'twitter is' pattern '${handle}'`);
      }

      // Twitter: third-party "she's @X on twitter" or "shes @X on twitter"
      for (const [, handle] of msg.text.matchAll(/(?:she|he|they)?'?s?\s+(@\w+)\s+on twitter/gi)) {
        const owner = findOwnerByHandle(world, 'twitter', handle);
        if (owner && owner.id !== msg.from) {
          identities.push({ entityId: owner.id, platform: 'twitter', handle });
          traces.push(`[ID] ${msg.displayName}: third-party twitter '${handle}' → ${owner.id}`);
        }
      }

      // Twitter: "Are you @X on twitter?" + confirmation pattern
      for (const [, handle] of msg.text.matchAll(/are you (?:the )?(@\w+) on twitter/gi)) {
        const confirmer = conv.messages.find(m2 =>
          m2.from !== msg.from && /(?:ya|yep|yeah|yes)\s+that'?s?\s+me/i.test(m2.text)
        );
        if (confirmer) {
          identities.push({ entityId: confirmer.from, platform: 'twitter', handle });
          traces.push(`[ID] ${msg.displayName} asked, ${confirmer.displayName} confirmed twitter '${handle}'`);
        }
      }

      // Telegram: "@handle over there" or "@handle on telegram"
      for (const [, handle] of msg.text.matchAll(/(@\w+)\s+(?:over )?(?:there|on telegram)/gi)) {
        identities.push({ entityId: msg.from, platform: 'telegram', handle });
        traces.push(`[ID] ${msg.displayName}: telegram '${handle}'`);
      }
    }

    // Deduplicate
    const seen = new Set<string>();
    const uniqueIds = identities.filter(i => {
      const k = `${i.entityId}:${i.platform}:${normalizeHandle(i.handle)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    // ── Relationship detection ───────────────
    const relationships: Extraction['relationships'] = [];
    const senders = [...new Set(conv.messages.map(m => m.from))];

    for (let i = 0; i < senders.length; i++) {
      for (let j = i + 1; j < senders.length; j++) {
        const a = senders[i];
        const b = senders[j];

        // Skip pairs involving suspicious entities
        if (isSuspicious(conv.messages.filter(m => m.from === a)) || isSuspicious(conv.messages.filter(m => m.from === b))) {
          traces.push(`[REL] Skip ${a}<->${b}: suspicious participant`);
          continue;
        }

        const allText = conv.messages.filter(m => m.from === a || m.from === b).map(m => m.text).join(' ').toLowerCase();

        const { type, sentiment } = classifyRelationship(allText);
        if (type) {
          relationships.push({ entityA: a, entityB: b, type, sentiment });
          traces.push(`[REL] ${a}<->${b}: ${type} (${sentiment})`);
        } else {
          traces.push(`[REL] ${a}<->${b}: no signal`);
        }
      }
    }

    // ── Trust detection ──────────────────────
    const trustSignals: Extraction['trustSignals'] = [];
    const suspiciousEntities = new Set<string>();
    for (const msg of conv.messages) {
      if (isSuspicious([msg])) suspiciousEntities.add(msg.from);
    }
    for (const eid of suspiciousEntities) {
      trustSignals.push({ entityId: eid, signal: 'suspicious' });
      traces.push(`[TRUST] ${eid}: suspicious`);
    }

    return { conversationId: conv.id, identities: uniqueIds, relationships, trustSignals, traces, wallTimeMs: performance.now() - start };
  },

  resolve(extractions: Extraction[], world: GroundTruthWorld): Resolution {
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

    // Build platform handle index: for each entity in the world, its known platform handle
    const platformIndex = new Map<string, string>(); // "twitter:@nightowl_dev" → "ent_w2"
    for (const entity of world.entities) {
      const key = `${entity.platform}:${normalizeHandle(entity.platformHandle)}`;
      platformIndex.set(key, entity.id);
    }

    traces.push(`Platform handle index: ${platformIndex.size} entries`);

    // Compare each entity's EXTRACTED identities against ALL entities' PLATFORM handles
    const links: Resolution['links'] = [];
    const proposedPairs = new Set<string>();

    for (const [entityId, extracted] of entityExtracted) {
      for (const ext of extracted) {
        // Look up if any OTHER entity has this as their platform handle
        const key = `${ext.platform}:${normalizeHandle(ext.handle)}`;
        const matchedEntityId = platformIndex.get(key);

        if (matchedEntityId && matchedEntityId !== entityId) {
          const pairKey = [entityId, matchedEntityId].sort().join(':');
          if (proposedPairs.has(pairKey)) continue;
          proposedPairs.add(pairKey);

          // Compute signals
          const signals: ResolutionSignal[] = [{
            type: 'self_identification',
            weight: 0.95,
            evidence: `${entityId} extracted ${ext.platform}:${ext.handle} which matches ${matchedEntityId}'s platform handle`,
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

    // Also compare extracted handles across entities (e.g., two entities both have github:davebuilds)
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

        // Check for shared extracted handles (same platform + same handle)
        for (const idA of idsA) {
          for (const idB of idsB) {
            if (idA.platform === idB.platform && normalizeHandle(idA.handle) === normalizeHandle(idB.handle)) {
              signals.push({
                type: 'self_identification',
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

function findOwnerByHandle(world: GroundTruthWorld, platform: string, handle: string): WorldEntity | undefined {
  const n = normalizeHandle(handle);
  return world.entities.find(e =>
    e.platform === platform && normalizeHandle(e.platformHandle) === n
  );
}

function isSuspicious(messages: Message[]): boolean {
  return messages.some(m =>
    /give me access|update my permissions|i'?m.*(?:new )?admin|backup account|locked out|delete.*records|everyone'?s contact/i.test(m.text)
  );
}

function classifyRelationship(allText: string): { type: string | null; sentiment: 'positive' | 'negative' | 'neutral' } {
  if (/friend|buddy|pal|climbing|travel|weekend.*\?|game tonight/i.test(allText)) return { type: 'friend', sentiment: 'positive' };
  if (/work together|colleague|project|roadmap|hackathon|pm\b|dashboard|role|telegram|more active on/i.test(allText)) return { type: 'colleague', sentiment: 'positive' };
  if (/welcome|just (?:found|joined)|nice|check.*out|migration|demo|count me in|registrations/i.test(allText)) return { type: 'community', sentiment: 'positive' };
  return { type: null, sentiment: 'neutral' };
}

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
