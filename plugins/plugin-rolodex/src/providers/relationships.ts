/**
 * Relationships Provider — enriched with entity links and decay.
 *
 * Injects relationship context into the agent's state, including:
 *  - Relationships sorted by decayed strength
 *  - Cross-platform identity links
 *  - Relationship evolution history
 */

import type { Entity, IAgentRuntime, Memory, Provider, Relationship, UUID } from '@elizaos/core';
import { computeRelationshipDecay } from '../utils/timeWeighting';
import { DEFAULT_RELATIONSHIP_DECAY_MS } from '../types/index';
import type { EntityResolutionService } from '../services/EntityResolutionService';

async function formatRelationships(runtime: IAgentRuntime, relationships: Relationship[]) {
  // Compute decayed strength for each relationship
  const withDecay = relationships
    .filter((rel) => rel.metadata?.interactionCount || rel.metadata?.strength)
    .map((rel) => {
      const baseStrength = (rel.metadata?.baseStrength as number) ?? (rel.metadata?.strength as number) ?? 50;
      const lastInteractionAt = rel.metadata?.lastInteractionAt as string | undefined;
      const halfLifeMs = (rel.metadata?.decayHalfLifeMs as number) ?? DEFAULT_RELATIONSHIP_DECAY_MS;

      const decayedStrength = computeRelationshipDecay(
        baseStrength,
        lastInteractionAt,
        halfLifeMs
      );

      return { rel, decayedStrength };
    })
    .sort((a, b) => b.decayedStrength - a.decayedStrength)
    .slice(0, 30);

  if (withDecay.length === 0) return '';

  // Batch fetch all target entities
  const uniqueEntityIds = Array.from(
    new Set(withDecay.map(({ rel }) => rel.targetEntityId as UUID))
  );
  const entities = await Promise.all(uniqueEntityIds.map((id) => runtime.getEntityById(id)));
  const entityMap = new Map<string, Entity | null>();
  entities.forEach((entity, index) => {
    if (entity) entityMap.set(uniqueEntityIds[index], entity);
  });

  // Check for entity links
  const resolutionService = runtime.getService('entity_resolution') as EntityResolutionService | null;

  const formatted = [];
  for (const { rel, decayedStrength } of withDecay) {
    const entity = entityMap.get(rel.targetEntityId as UUID);
    if (!entity) continue;

    const names = entity.names.join(' aka ');
    const relType = (rel.metadata?.relationshipType as string) ?? 'unknown';
    const sentiment = (rel.metadata?.sentiment as string) ?? 'neutral';
    const interactions = (rel.metadata?.interactionCount as number) ?? 0;
    const lastAt = (rel.metadata?.lastInteractionAt as string) ?? 'unknown';

    let line = `${names} [${relType}, ${sentiment}] strength: ${decayedStrength}/100, interactions: ${interactions}, last: ${lastAt}`;

    // Add cross-platform links if available
    if (resolutionService) {
      const links = await resolutionService.getLinks(entity.id as UUID);
      const confirmedLinks = links.filter((l) => l.status === 'confirmed' || l.status === 'proposed');
      if (confirmedLinks.length > 0) {
        const linkedNames: string[] = [];
        for (const link of confirmedLinks) {
          const otherId = link.entityA === entity.id ? link.entityB : link.entityA;
          const otherEntity = await runtime.getEntityById(otherId);
          if (otherEntity) {
            linkedNames.push(
              `${otherEntity.names[0]} (${link.status}, confidence: ${link.confidence.toFixed(2)})`
            );
          }
        }
        if (linkedNames.length > 0) {
          line += `\n  Possible same person as: ${linkedNames.join(', ')}`;
        }
      }
    }

    // Add platform identities
    const identities = entity.metadata?.platformIdentities;
    if (Array.isArray(identities) && identities.length > 0) {
      const idStrs = identities.map((pi) => {
        const rec = pi as Record<string, unknown>;
        return `${rec.platform}:${rec.handle}`;
      });
      line += `\n  Identities: ${idStrs.join(', ')}`;
    }

    // Add evolution history snippet
    const history = rel.metadata?.history;
    if (Array.isArray(history) && history.length > 1) {
      const first = history[0] as Record<string, unknown>;
      const last = history[history.length - 1] as Record<string, unknown>;
      line += `\n  Evolution: ${first.type} -> ${last.type} (${history.length} transitions)`;
    }

    formatted.push(line);
  }

  return formatted.join('\n\n');
}

const relationshipsProvider: Provider = {
  name: 'RELATIONSHIPS',
  description:
    'Relationships between {{agentName}} and other people, including cross-platform identity links and relationship evolution',
  dynamic: true,
  get: async (runtime: IAgentRuntime, message: Memory) => {
    const relationships = await runtime.getRelationships({
      entityIds: [message.entityId],
    });

    if (!relationships || relationships.length === 0) {
      return {
        data: { relationships: [] },
        values: { relationships: 'No relationships found.' },
        text: 'No relationships found.',
      };
    }

    const formattedRelationships = await formatRelationships(runtime, relationships);

    if (!formattedRelationships) {
      return {
        data: { relationships: [] },
        values: { relationships: 'No relationships found.' },
        text: 'No relationships found.',
      };
    }

    return {
      data: { relationships: formattedRelationships },
      values: { relationships: formattedRelationships },
      text: `# ${runtime.character.name}'s relationship context for ${message.content?.senderName ?? message.content?.name ?? 'this person'}:\n${formattedRelationships}`,
    };
  },
};

export { relationshipsProvider };
