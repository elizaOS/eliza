/**
 * Relationship Extraction Evaluator
 *
 * Replaces the regex-based approach with LLM-powered extraction.
 * Runs on every message and extracts:
 *   - Platform identities (with provenance and scope)
 *   - Relationship indicators between participants
 *   - Mentioned third parties
 *   - Disputes / corrections
 *   - Privacy boundaries
 *   - Trust signals
 *
 * The LLM does the understanding; we do the storage and bookkeeping.
 */

import {
  type Evaluator,
  type IAgentRuntime,
  type Memory,
  type State,
  type UUID,
  type Entity,
  type ActionResult,
  ModelType,
  logger,
  stringToUuid,
} from '@elizaos/core';

import type {
  ExtractionResult,
  ExtractedIdentity,
  ExtractedRelationship,
  ExtractedDispute,
  ExtractedPrivacy,
  ExtractedTrustSignal,
  ExtractedMention,
  InformationTier,
  ClaimScope,
  RolodexRelationshipMetadata,
  RelationshipType,
  RelationshipSnapshot,
} from '../types/index';

import { DEFAULT_HALF_LIVES, DEFAULT_RELATIONSHIP_DECAY_MS } from '../types/index';

// ──────────────────────────────────────────────
// LLM Extraction Prompt
// ──────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are analyzing a conversation to extract social and identity information.

## Participants in this room:
{{participants}}

## Recent conversation:
{{recentMessages}}

## Your task:
Analyze the conversation and extract ALL of the following. Be precise and conservative — only extract what is clearly stated or strongly implied. Do not hallucinate.

Return a JSON object with these fields:

{
  "platformIdentities": [
    {
      "platform": "twitter|discord|github|telegram|etc",
      "handle": "the handle/username",
      "belongsTo": "name of the person this handle belongs to",
      "confidence": 0.0-1.0,
      "reportedBy": "self|other"
    }
  ],
  "relationships": [
    {
      "personA": "name",
      "personB": "name",
      "type": "friend|colleague|family|community|acquaintance|mentor|adversarial",
      "sentiment": "positive|negative|neutral",
      "confidence": 0.0-1.0,
      "evidence": "brief quote or description of what indicates this relationship"
    }
  ],
  "mentionedPeople": [
    {
      "name": "name of person mentioned",
      "context": "what was said about them",
      "attributes": { "key": "value" },
      "isParticipant": true/false
    }
  ],
  "disputes": [
    {
      "disputer": "name of person disputing",
      "about": "name of person whose info is disputed",
      "field": "what field is disputed (e.g. twitter_handle, email, name)",
      "existingValue": "the value being challenged",
      "proposedValue": "the new value being proposed",
      "confidence": 0.0-1.0
    }
  ],
  "privacyBoundaries": [
    {
      "requestedBy": "name",
      "content": "what should be kept private",
      "hiddenFrom": "everyone|specific_name",
      "confidence": 0.0-1.0
    }
  ],
  "trustSignals": [
    {
      "entityName": "name",
      "signal": "helpful|suspicious|authoritative|deceptive|neutral",
      "evidence": "why this signal was detected",
      "severity": 0.0-1.0
    }
  ]
}

IMPORTANT RULES:
- If a person says "my Twitter is @X", that's self-reported with confidence 0.8
- If person A says "person B's Twitter is @X", that's hearsay with confidence 0.5
- Only mark something as "suspicious" if there are genuine red flags (asking for passwords, claiming admin status without proof, requesting deletion of others' data)
- For privacy: only flag explicit requests ("don't tell anyone", "keep this between us"), NOT casual mentions of the word "private"
- For disputes: only flag when someone is actively correcting or contradicting previously stated information
- Return empty arrays for categories with no findings
- Do NOT include the agent itself in relationship extraction`;

// ──────────────────────────────────────────────
// Evaluator Definition
// ──────────────────────────────────────────────

export const relationshipExtractionEvaluator: Evaluator = {
  name: 'RELATIONSHIP_EXTRACTION',
  description: 'Extracts relationship and identity information from conversations using LLM analysis',
  similes: ['RELATIONSHIP_ANALYZER', 'SOCIAL_GRAPH_BUILDER', 'CONTACT_EXTRACTOR'],
  alwaysRun: true,

  examples: [
    {
      prompt: 'User introduces themselves with social media handles',
      messages: [
        {
          name: '{{name1}}',
          content: {
            type: 'text',
            text: "Hi, I'm Sarah Chen. You can find me on Twitter @sarahchen_dev",
          },
        },
      ],
      outcome:
        'Extracts Twitter handle as self-reported identity, creates claim with 0.8 confidence scoped to this platform',
    },
    {
      prompt: 'Someone disputes previously stated information',
      messages: [
        {
          name: '{{name1}}',
          content: { type: 'text', text: "That's not actually Sarah's Twitter. Her real handle is @sarah_c_developer" },
        },
      ],
      outcome: 'Creates a dispute record with the original and proposed values, lowers confidence on the original claim',
    },
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    return !!(message.content?.text && message.content.text.trim().length > 5);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State
  ): Promise<ActionResult | void> => {
    try {
      // Get recent messages for context
      const recentMessages = await runtime.getMemories({
        roomId: message.roomId,
        tableName: 'messages',
        count: 15,
        unique: false,
      });

      if (recentMessages.length === 0) return;

      // Get participants in the room
      const participants = await runtime.getEntitiesForRoom(message.roomId, true);

      // Format for the LLM
      const participantsList = participants
        .map((e) => `- ${e.names.join(' / ')} (ID: ${e.id})`)
        .join('\n');

      const messagesList = recentMessages
        .slice()
        .reverse()
        .map((m) => {
          const entity = participants.find((p) => p.id === m.entityId);
          const name = entity?.names[0] ?? 'Unknown';
          return `[${name}]: ${m.content?.text ?? ''}`;
        })
        .join('\n');

      const prompt = EXTRACTION_PROMPT
        .replace('{{participants}}', participantsList)
        .replace('{{recentMessages}}', messagesList);

      // Call the LLM
      const extraction = await runtime.useModel(ModelType.OBJECT_SMALL, {
        prompt,
      }) as ExtractionResult | null;

      if (!extraction) {
        logger.debug('[RelationshipExtraction] LLM returned empty response');
        return;
      }

      // Process each category of extracted data
      const results = {
        identitiesStored: 0,
        relationshipsUpdated: 0,
        mentionsProcessed: 0,
        disputesRecorded: 0,
        privacyMarkers: 0,
        trustUpdates: 0,
      };

      // 1. Platform identities
      if (Array.isArray(extraction.platformIdentities)) {
        for (const identity of extraction.platformIdentities) {
          await processIdentity(runtime, identity, message, participants);
          results.identitiesStored++;
        }
      }

      // 2. Relationships
      if (Array.isArray(extraction.relationships)) {
        for (const rel of extraction.relationships) {
          await processRelationship(runtime, rel, message, participants);
          results.relationshipsUpdated++;
        }
      }

      // 3. Mentioned people
      if (Array.isArray(extraction.mentionedPeople)) {
        for (const mention of extraction.mentionedPeople) {
          await processMention(runtime, mention, message, participants);
          results.mentionsProcessed++;
        }
      }

      // 4. Disputes
      if (Array.isArray(extraction.disputes)) {
        for (const dispute of extraction.disputes) {
          await processDispute(runtime, dispute, message, participants);
          results.disputesRecorded++;
        }
      }

      // 5. Privacy boundaries
      if (Array.isArray(extraction.privacyBoundaries)) {
        for (const privacy of extraction.privacyBoundaries) {
          await processPrivacy(runtime, privacy, message, participants);
          results.privacyMarkers++;
        }
      }

      // 6. Trust signals
      if (Array.isArray(extraction.trustSignals)) {
        for (const signal of extraction.trustSignals) {
          await processTrustSignal(runtime, signal, message, participants);
          results.trustUpdates++;
        }
      }

      logger.info(
        `[RelationshipExtraction] Processed message ${message.id}: ` +
          `${results.identitiesStored} identities, ${results.relationshipsUpdated} relationships, ` +
          `${results.mentionsProcessed} mentions, ${results.disputesRecorded} disputes, ` +
          `${results.privacyMarkers} privacy, ${results.trustUpdates} trust`
      );

      return {
        success: true,
        values: results,
        data: { extraction },
        text: `Extracted ${results.identitiesStored} identities, ${results.relationshipsUpdated} relationships, ${results.disputesRecorded} disputes.`,
      };
    } catch (error) {
      logger.error(
        '[RelationshipExtraction] Error:',
        error instanceof Error ? error.message : String(error)
      );
      return;
    }
  },
};

// ──────────────────────────────────────────────
// Processing Functions
// ──────────────────────────────────────────────

/**
 * Resolve a name from the LLM output to an actual entity in the room.
 */
function resolveNameToEntity(name: string, participants: Entity[]): Entity | undefined {
  const lower = name.toLowerCase().trim();
  return participants.find((p) =>
    p.names.some((n) => n.toLowerCase() === lower || n.toLowerCase().includes(lower))
  );
}

/**
 * Store a platform identity as an information claim component.
 */
async function processIdentity(
  runtime: IAgentRuntime,
  identity: ExtractedIdentity,
  message: Memory,
  participants: Entity[]
): Promise<void> {
  // Figure out who this identity belongs to
  const entity = resolveNameToEntity(identity.belongsTo, participants);
  const targetEntityId = entity?.id ?? message.entityId;

  // Determine the tier based on who reported it
  const tier: InformationTier = identity.reportedBy === 'self' ? 'self_reported' : 'hearsay';
  const scope: ClaimScope = identity.reportedBy === 'self' ? 'platform' : 'room';

  // Store as a component (information claim)
  const claimId = stringToUuid(
    `claim-${targetEntityId}-${identity.platform}-${identity.handle}-${runtime.agentId}`
  );

  const existingComponents = await runtime.getComponents(targetEntityId);
  const existingClaim = existingComponents.find(
    (c) =>
      c.type === 'information_claim' &&
      c.data.field === 'platform_identity' &&
      c.data.platform === identity.platform &&
      c.data.value === identity.handle
  );

  if (existingClaim) {
    // Corroborate existing claim if from a new source
    const corroborations = Array.isArray(existingClaim.data.corroborations)
      ? (existingClaim.data.corroborations as Array<Record<string, unknown>>)
      : [];

    const alreadyCorroborated = corroborations.some(
      (c) => c.entityId === message.entityId
    );

    if (!alreadyCorroborated && message.entityId !== existingClaim.data.sourceEntityId) {
      corroborations.push({
        entityId: message.entityId as string,
        timestamp: Date.now(),
        context: message.content?.text?.substring(0, 100) ?? '',
      });

      await runtime.updateComponent({
        ...existingClaim,
        data: {
          ...existingClaim.data,
          corroborations,
          confidence: Math.min(1, (existingClaim.data.confidence as number) + 0.1),
          updatedAt: Date.now(),
        },
      });
    }
    return;
  }

  // Create new claim
  await runtime.createComponent({
    id: claimId,
    type: 'information_claim',
    agentId: runtime.agentId,
    entityId: targetEntityId,
    roomId: message.roomId,
    worldId: stringToUuid(`rolodex-world-${runtime.agentId}`),
    sourceEntityId: message.entityId,
    data: {
      field: 'platform_identity',
      platform: identity.platform,
      value: identity.handle,
      tier,
      confidence: identity.confidence,
      baseConfidence: identity.confidence,
      sourceEntityId: message.entityId as string,
      sourceContext: {
        platform: (message.content?.source as string) ?? 'unknown',
        roomId: message.roomId as string,
        messageId: (message.id ?? '') as string,
        timestamp: Date.now(),
      },
      corroborations: [],
      disputes: [],
      scope,
      halfLifeMs: DEFAULT_HALF_LIVES[tier],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    createdAt: Date.now(),
  });

  // Also store in entity metadata for backward compatibility
  const targetEntity = entity ?? (await runtime.getEntityById(targetEntityId));
  if (targetEntity) {
    const metadata = targetEntity.metadata ?? {};
    const platformIdentities = Array.isArray(metadata.platformIdentities)
      ? (metadata.platformIdentities as Array<Record<string, unknown>>)
      : [];

    const exists = platformIdentities.some(
      (pi) => pi.platform === identity.platform && pi.handle === identity.handle
    );

    if (!exists) {
      platformIdentities.push({
        platform: identity.platform,
        handle: identity.handle,
        verified: false,
        confidence: identity.confidence,
        source: message.entityId as string,
        timestamp: Date.now(),
        tier,
        scope,
      });
      metadata.platformIdentities = platformIdentities;
      await runtime.updateEntity({ ...targetEntity, metadata });
    }
  }
}

/**
 * Process an extracted relationship between two people.
 */
async function processRelationship(
  runtime: IAgentRuntime,
  rel: ExtractedRelationship,
  message: Memory,
  participants: Entity[]
): Promise<void> {
  const entityA = resolveNameToEntity(rel.personA, participants);
  const entityB = resolveNameToEntity(rel.personB, participants);

  if (!entityA || !entityB) return;
  if (entityA.id === entityB.id) return;

  const entityAId = entityA.id as UUID;
  const entityBId = entityB.id as UUID;

  // Check existing relationship
  const relationships = await runtime.getRelationships({ entityId: entityAId });
  const existing = relationships.find(
    (r) =>
      (r.sourceEntityId === entityAId && r.targetEntityId === entityBId) ||
      (r.sourceEntityId === entityBId && r.targetEntityId === entityAId)
  );

  const relType = (rel.type ?? 'acquaintance') as RelationshipType;
  const now = new Date().toISOString();

  if (existing) {
    // Update existing relationship
    const metadata = (existing.metadata ?? {}) as Record<string, unknown>;
    const interactionCount = ((metadata.interactionCount as number) ?? 0) + 1;

    // Track history for evolution
    const history = Array.isArray(metadata.history)
      ? (metadata.history as Array<Record<string, unknown>>)
      : [];

    // Only snapshot if type or sentiment changed
    const prevType = metadata.relationshipType as string;
    const prevSentiment = metadata.sentiment as string;
    if (prevType !== relType || prevSentiment !== rel.sentiment) {
      history.push({
        type: relType,
        strength: (metadata.baseStrength as number) ?? 50,
        sentiment: rel.sentiment,
        timestamp: Date.now(),
      });
    }

    const baseStrength = Math.min(100, ((metadata.baseStrength as number) ?? 50) + 2);

    await runtime.updateRelationship({
      ...existing,
      tags: Array.from(new Set([...(existing.tags ?? []), 'rolodex', relType])),
      metadata: {
        ...metadata,
        relationshipType: relType,
        sentiment: rel.sentiment,
        strength: baseStrength,
        baseStrength,
        interactionCount,
        lastInteractionAt: now,
        history,
        decayHalfLifeMs: (metadata.decayHalfLifeMs as number) ?? DEFAULT_RELATIONSHIP_DECAY_MS,
        lastDecayAt: Date.now(),
        autoDetected: true,
      },
    });
  } else {
    // Create new relationship
    const initialHistory: RelationshipSnapshot[] = [
      {
        type: relType,
        strength: 40,
        sentiment: rel.sentiment,
        timestamp: Date.now(),
      },
    ];

    await runtime.createRelationship({
      sourceEntityId: entityAId,
      targetEntityId: entityBId,
      tags: ['rolodex', relType],
      metadata: {
        relationshipType: relType,
        sentiment: rel.sentiment,
        strength: 40,
        baseStrength: 40,
        interactionCount: 1,
        lastInteractionAt: now,
        history: initialHistory as unknown as Array<Record<string, unknown>>,
        decayHalfLifeMs: DEFAULT_RELATIONSHIP_DECAY_MS,
        lastDecayAt: Date.now(),
        autoDetected: true,
      },
    });
  }
}

/**
 * Process a mentioned third party.
 */
async function processMention(
  runtime: IAgentRuntime,
  mention: ExtractedMention,
  message: Memory,
  participants: Entity[]
): Promise<void> {
  if (mention.isParticipant) return; // Already tracked

  // Search for existing entity by name among participants
  const existing = resolveNameToEntity(mention.name, participants);

  if (existing) {
    // Update with new mention context
    const metadata = existing.metadata ?? {};
    const mentions = Array.isArray(metadata.mentions)
      ? (metadata.mentions as Array<Record<string, unknown>>)
      : [];

    mentions.push({
      by: message.entityId as string,
      context: mention.context.substring(0, 200),
      timestamp: Date.now(),
      attributes: mention.attributes,
    });
    metadata.mentions = mentions;

    await runtime.updateEntity({ ...existing, metadata });
  } else {
    // Create entity for the mentioned person
    // Use a deterministic ID so we don't create duplicates for the same name
    const entityId = stringToUuid(`mentioned-${mention.name.toLowerCase()}-${runtime.agentId}`);

    try {
      await runtime.createEntity({
        id: entityId,
        agentId: runtime.agentId,
        names: [mention.name],
        metadata: {
          mentionedBy: message.entityId as string,
          mentionContext: mention.context.substring(0, 200),
          attributes: mention.attributes,
          createdFrom: 'mention',
          firstMentionedAt: Date.now(),
        },
      });
    } catch {
      // Entity might already exist from a previous mention — update instead
      const existingEntity = await runtime.getEntityById(entityId);
      if (existingEntity) {
        const metadata = existingEntity.metadata ?? {};
        const mentions = Array.isArray(metadata.mentions)
          ? (metadata.mentions as Array<Record<string, unknown>>)
          : [];

        mentions.push({
          by: message.entityId as string,
          context: mention.context.substring(0, 200),
          timestamp: Date.now(),
        });
        metadata.mentions = mentions;
        await runtime.updateEntity({ ...existingEntity, metadata });
      }
    }
  }
}

/**
 * Record a dispute as a component and lower confidence on affected claims.
 */
async function processDispute(
  runtime: IAgentRuntime,
  dispute: ExtractedDispute,
  message: Memory,
  participants: Entity[]
): Promise<void> {
  const aboutEntity = resolveNameToEntity(dispute.about, participants);
  const disputerEntity = resolveNameToEntity(dispute.disputer, participants);

  const aboutId = aboutEntity?.id ?? stringToUuid(`unknown-${dispute.about}-${runtime.agentId}`);
  const disputerId = disputerEntity?.id ?? message.entityId;

  // Create dispute record component
  await runtime.createComponent({
    id: stringToUuid(`dispute-${Date.now()}-${disputerId}`),
    type: 'dispute_record',
    agentId: runtime.agentId,
    entityId: aboutId,
    roomId: message.roomId,
    worldId: stringToUuid(`rolodex-world-${runtime.agentId}`),
    sourceEntityId: disputerId,
    data: {
      disputedEntity: dispute.about,
      disputedField: dispute.field,
      originalValue: dispute.existingValue,
      claimedValue: dispute.proposedValue,
      disputer: disputerId as string,
      disputerName: dispute.disputer,
      confidence: dispute.confidence,
      timestamp: Date.now(),
      resolved: false,
    },
    createdAt: Date.now(),
  });

  // If we have existing claims that match, add the dispute to them
  if (aboutEntity) {
    const components = await runtime.getComponents(aboutEntity.id as UUID);
    const matchingClaims = components.filter(
      (c) =>
        c.type === 'information_claim' &&
        c.data.field === dispute.field &&
        c.data.value === dispute.existingValue
    );

    for (const claim of matchingClaims) {
      const disputes = Array.isArray(claim.data.disputes)
        ? (claim.data.disputes as Array<Record<string, unknown>>)
        : [];

      disputes.push({
        entityId: disputerId as string,
        alternativeValue: dispute.proposedValue,
        timestamp: Date.now(),
        context: message.content?.text?.substring(0, 200) ?? '',
        resolved: false,
      });

      // Lower confidence
      const currentConfidence = (claim.data.confidence as number) ?? 0.5;
      const newConfidence = Math.max(0.1, currentConfidence - 0.15 * dispute.confidence);

      await runtime.updateComponent({
        ...claim,
        data: {
          ...claim.data,
          disputes,
          confidence: newConfidence,
          updatedAt: Date.now(),
        },
      });
    }
  }
}

/**
 * Create a privacy marker component.
 */
async function processPrivacy(
  runtime: IAgentRuntime,
  privacy: ExtractedPrivacy,
  message: Memory,
  participants: Entity[]
): Promise<void> {
  const entity = resolveNameToEntity(privacy.requestedBy, participants);
  const entityId = entity?.id ?? message.entityId;

  await runtime.createComponent({
    id: stringToUuid(`privacy-${Date.now()}-${entityId}`),
    type: 'privacy_marker',
    agentId: runtime.agentId,
    entityId,
    roomId: message.roomId,
    worldId: stringToUuid(`rolodex-world-${runtime.agentId}`),
    sourceEntityId: entityId,
    data: {
      content: privacy.content.substring(0, 500),
      hiddenFrom: privacy.hiddenFrom,
      confidence: privacy.confidence,
      requestedBy: privacy.requestedBy,
      timestamp: Date.now(),
    },
    createdAt: Date.now(),
  });

  // Mark entity metadata
  if (entity) {
    const metadata = entity.metadata ?? {};
    metadata.hasPrivacyBoundaries = true;
    await runtime.updateEntity({ ...entity, metadata });
  }
}

/**
 * Update trust metrics on an entity based on observed signals.
 */
async function processTrustSignal(
  runtime: IAgentRuntime,
  signal: ExtractedTrustSignal,
  message: Memory,
  participants: Entity[]
): Promise<void> {
  const entity = resolveNameToEntity(signal.entityName, participants);
  if (!entity) return;

  const metadata = entity.metadata ?? {};
  const trustMetrics = (metadata.trustMetrics ?? {
    helpfulness: 0,
    consistency: 0.5,
    engagement: 0,
    suspicionLevel: 0,
    authorityLevel: 0,
  }) as Record<string, number>;

  // Update based on signal type using exponential moving average
  const alpha = 0.3; // Learning rate

  switch (signal.signal) {
    case 'helpful':
      trustMetrics.helpfulness = trustMetrics.helpfulness * (1 - alpha) + signal.severity * alpha;
      break;
    case 'suspicious':
      trustMetrics.suspicionLevel =
        trustMetrics.suspicionLevel * (1 - alpha) + signal.severity * alpha;
      break;
    case 'authoritative':
      trustMetrics.authorityLevel =
        (trustMetrics.authorityLevel ?? 0) * (1 - alpha) + signal.severity * alpha;
      break;
    case 'deceptive':
      trustMetrics.suspicionLevel =
        trustMetrics.suspicionLevel * (1 - alpha) + signal.severity * alpha * 1.5;
      trustMetrics.consistency = Math.max(0, trustMetrics.consistency - 0.1 * signal.severity);
      break;
    case 'neutral':
      break;
  }

  trustMetrics.engagement = (trustMetrics.engagement ?? 0) + 1;
  trustMetrics.lastAssessed = Date.now();

  metadata.trustMetrics = trustMetrics;
  await runtime.updateEntity({ ...entity, metadata });
}
