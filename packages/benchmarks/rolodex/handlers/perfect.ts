import type { Handler, Conversation, Extraction, Resolution, GroundTruthWorld } from '../types';

export const perfectHandler: Handler = {
  name: 'Perfect (Oracle)',
  extract(conv: Conversation): Extraction {
    return {
      conversationId: conv.id,
      identities: conv.expected.identities.map(i => ({ ...i })),
      relationships: conv.expected.relationships.map(r => ({ ...r })),
      trustSignals: conv.expected.trustSignals.map(t => ({ ...t })),
      traces: ['Oracle: returned ground truth'],
      wallTimeMs: 0,
    };
  },
  resolve(_ext: Extraction[], world: GroundTruthWorld): Resolution {
    return {
      links: world.links.map(l => ({ entityA: l.entityA, entityB: l.entityB, confidence: 1.0, signals: [`Truth: ${l.reason}`] })),
      traces: ['Oracle: returned ground truth links'],
      wallTimeMs: 0,
    };
  },
};
