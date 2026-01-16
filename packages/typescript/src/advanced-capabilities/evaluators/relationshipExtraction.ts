import { requireEvaluatorSpec } from "../../generated/spec-helpers.ts";
import { logger } from "../../logger.ts";
import type { RolodexService } from "../../services/rolodex.ts";
import type {
  ActionResult,
  Entity,
  EvaluationExample,
  Evaluator,
  IAgentRuntime,
  Memory,
  State,
  UUID,
} from "../../types/index.ts";
import { stringToUuid } from "../../utils.ts";

// Get text content from centralized specs
const spec = requireEvaluatorSpec("RELATIONSHIP_EXTRACTION");

interface PlatformIdentity {
  platform: string;
  handle: string;
  verified: boolean;
  confidence: number;
  source?: UUID;
  timestamp: number;
}

interface RelationshipIndicator {
  type: "friend" | "colleague" | "community" | "family" | "acquaintance";
  sentiment: "positive" | "negative" | "neutral";
  confidence: number;
  context: string;
}

interface DisputeInfo {
  disputedEntity: string;
  disputedField: string;
  originalValue: string;
  claimedValue: string;
  disputer?: UUID;
}

interface PrivacyInfo {
  type: "confidential" | "doNotShare" | "private";
  content: string;
  context: string;
}

interface MentionedPerson {
  name: string;
  context: string;
  attributes: Record<string, unknown>;
}

export const relationshipExtractionEvaluator: Evaluator = {
  name: spec.name,
  description: spec.description,
  similes: spec.similes ? [...spec.similes] : [],
  alwaysRun: spec.alwaysRun ?? false,
  examples: (spec.examples ?? []) as EvaluationExample[],

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    // Always run for messages in conversations
    return !!(message.content?.text && message.content.text.length > 0);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<ActionResult | undefined> => {
    const rolodexService = runtime.getService("rolodex") as RolodexService;
    if (!rolodexService) {
      logger.warn("[RelationshipExtraction] RolodexService not available");
      return;
    }

    // Get recent messages for context
    const recentMessages = await runtime.getMemories({
      roomId: message.roomId,
      tableName: "messages",
      count: 10,
      unique: false,
    });

    if (!message.content?.text) {
      return;
    }

    // Extract platform identities from the current message
    const identities = extractPlatformIdentities(message.content.text);
    if (identities.length > 0) {
      await storePlatformIdentities(runtime, message.entityId, identities);
    }

    // Check for disputes or corrections
    const disputeInfo = detectDispute(message.content.text, recentMessages);
    if (disputeInfo) {
      await handleDispute(runtime, disputeInfo, message);
    }

    // Analyze relationships between participants
    if (recentMessages.length > 1) {
      await analyzeRelationships(runtime, recentMessages, rolodexService);
    }

    // Extract information about mentioned third parties
    const mentionedPeople = extractMentionedPeople(message.content.text);
    for (const person of mentionedPeople) {
      await createOrUpdateMentionedEntity(runtime, person, message.entityId);
    }

    // Assess trust and behavior patterns
    await assessTrustIndicators(runtime, message.entityId, recentMessages);

    // Detect privacy boundaries
    const privacyInfo = detectPrivacyBoundaries(message.content.text);
    if (privacyInfo) {
      await handlePrivacyBoundary(runtime, privacyInfo, message);
    }

    // Handle admin user updates
    await handleAdminUpdates(runtime, message, recentMessages);

    logger.info(
      {
        src: "plugin:bootstrap:evaluator:relationship_extraction",
        agentId: runtime.agentId,
        messageId: message.id,
        identitiesFound: identities.length,
        disputeDetected: !!disputeInfo,
        mentionedPeople: mentionedPeople.length,
      },
      "Completed extraction for message",
    );

    return {
      success: true,
      values: {
        identitiesFound: identities.length,
        disputeDetected: !!disputeInfo,
        mentionedPeopleCount: mentionedPeople.length,
      },
      data: {
        identitiesCount: identities.length,
        hasDispute: !!disputeInfo,
        mentionedPeopleCount: mentionedPeople.length,
      },
      text: `Extracted ${identities.length} identities, ${mentionedPeople.length} mentioned people, and ${disputeInfo ? "1 dispute" : "0 disputes"}.`,
    };
  },
};

function extractPlatformIdentities(text: string): PlatformIdentity[] {
  const identities: PlatformIdentity[] = [];
  const now = Date.now();

  // X handles
  const xMatches = text.match(/@[\w]+/g);
  if (xMatches) {
    for (const handle of xMatches) {
      if (!handle.match(/@(here|everyone|channel)/)) {
        // Skip Discord mentions
        identities.push({
          platform: "x",
          handle: handle,
          verified: false,
          confidence: 0.7,
          timestamp: now,
        });
      }
    }
  }

  // GitHub usernames
  const githubPattern = /github\.com\/(\w+)|@(\w+) on github/gi;
  let githubMatch = githubPattern.exec(text);
  while (githubMatch !== null) {
    identities.push({
      platform: "github",
      handle: githubMatch[1] || githubMatch[2],
      verified: false,
      confidence: 0.8,
      timestamp: now,
    });
    githubMatch = githubPattern.exec(text);
  }

  // Discord usernames
  const discordPattern = /discord:?\s*(\w+#\d{4})|my discord is (\w+#\d{4})/gi;
  let discordMatch = discordPattern.exec(text);
  while (discordMatch !== null) {
    identities.push({
      platform: "discord",
      handle: discordMatch[1] || discordMatch[2],
      verified: false,
      confidence: 0.8,
      timestamp: now,
    });
    discordMatch = discordPattern.exec(text);
  }

  return identities;
}

async function storePlatformIdentities(
  runtime: IAgentRuntime,
  entityId: UUID,
  identities: PlatformIdentity[],
) {
  const entity = await runtime.getEntityById(entityId);
  if (!entity) return;

  const metadata = entity.metadata || {};
  const rawIdentities = metadata.platformIdentities;
  const platformIdentities = (
    Array.isArray(rawIdentities) ? rawIdentities : []
  ) as Array<Record<string, unknown>>;
  const existingByKey = new Map<string, Record<string, unknown>>();
  for (const identity of platformIdentities) {
    const key = `${identity.platform ?? ""}|${identity.handle ?? ""}`;
    if (key !== "|") {
      existingByKey.set(key, identity);
    }
  }

  for (const identity of identities) {
    const identityRecord: Record<string, unknown> = {
      platform: identity.platform,
      handle: identity.handle,
      verified: identity.verified,
      confidence: identity.confidence,
      source: entityId,
      timestamp: identity.timestamp,
    };

    // Check if we already have this identity
    const identityKey = `${identity.platform}|${identity.handle}`;
    const existing = existingByKey.get(identityKey);

    if (!existing) {
      existingByKey.set(identityKey, identityRecord);
      platformIdentities.push(identityRecord);
    } else if ((existing.confidence as number) < identity.confidence) {
      // Update if new info has higher confidence
      Object.assign(existing, identityRecord);
    }
  }

  // Store as array of objects with string keys
  metadata.platformIdentities = platformIdentities as Array<{
    [key: string]: string | number | boolean | null | undefined;
  }>;
  await runtime.updateEntity({ ...entity, metadata });
}

function detectDispute(
  text: string,
  _recentMessages: Memory[],
): DisputeInfo | null {
  const disputePhrases = [
    /that'?s not (actually|really) their (\w+)/i,
    /no,? (actually|really) it'?s (\w+)/i,
    /you'?re wrong,? it'?s (\w+)/i,
    /that'?s incorrect/i,
  ];

  for (const pattern of disputePhrases) {
    if (pattern.test(text)) {
      // Simple dispute detection - would be enhanced with NLP
      return {
        disputedEntity: "unknown", // Would extract from context
        disputedField: "platform_identity",
        originalValue: "unknown",
        claimedValue: "unknown",
      };
    }
  }

  return null;
}

async function handleDispute(
  runtime: IAgentRuntime,
  dispute: DisputeInfo,
  message: Memory,
) {
  dispute.disputer = message.entityId;

  // Store dispute in a dedicated component
  await runtime.createComponent({
    id: stringToUuid(`dispute-${Date.now()}-${message.entityId}`),
    type: "dispute_record",
    agentId: runtime.agentId,
    entityId: message.entityId,
    roomId: message.roomId,
    worldId: stringToUuid(`rolodex-world-${runtime.agentId}`),
    sourceEntityId: message.entityId,
    data: {
      disputedEntity: dispute.disputedEntity,
      disputedField: dispute.disputedField,
      originalValue: dispute.originalValue,
      claimedValue: dispute.claimedValue,
      disputer: dispute.disputer,
    },
    createdAt: Date.now(),
  });

  logger.info(
    {
      src: "plugin:bootstrap:evaluator:relationship_extraction",
      agentId: runtime.agentId,
      dispute,
    },
    "Dispute recorded",
  );
}

async function analyzeRelationships(
  runtime: IAgentRuntime,
  messages: Memory[],
  _rolodexService: RolodexService,
) {
  // Group messages by sender
  const messagesBySender = new Map<UUID, Memory[]>();
  for (const msg of messages) {
    const senderMessages = messagesBySender.get(msg.entityId) || [];
    senderMessages.push(msg);
    messagesBySender.set(msg.entityId, senderMessages);
  }

  // Analyze interactions between each pair of users
  const senders = Array.from(messagesBySender.keys());
  for (let i = 0; i < senders.length; i++) {
    for (let j = i + 1; j < senders.length; j++) {
      const entityA = senders[i];
      const entityB = senders[j];

      const messagesA = messagesBySender.get(entityA) || [];
      const messagesB = messagesBySender.get(entityB) || [];

      const indicators = analyzeInteraction(messagesA, messagesB);

      if (indicators.length > 0) {
        await updateRelationship(runtime, entityA, entityB, indicators);
      }
    }
  }
}

function analyzeInteraction(
  messagesA: Memory[],
  messagesB: Memory[],
): RelationshipIndicator[] {
  const indicators: RelationshipIndicator[] = [];

  // Look for friendship indicators
  const friendPhrases = [
    /thanks.*friend/i,
    /you'?re a (great|good|true) friend/i,
    /appreciate you/i,
    /love you/i,
    /buddy|pal/i,
    /grab coffee/i,
  ];

  // Look for colleague indicators
  const colleaguePhrases = [
    /code review/i,
    /project|meeting|deadline/i,
    /colleague|coworker/i,
    /work together/i,
    /team|department/i,
  ];

  // Look for community indicators
  const communityPhrases = [
    /community|group/i,
    /event|meetup/i,
    /member/i,
    /contribute|volunteer/i,
    /help with|count me in/i,
    /together we can/i,
  ];

  // Analyze all messages
  const allMessages = [...messagesA, ...messagesB];
  for (const msg of allMessages) {
    const text = msg.content?.text;
    if (!text) continue;

    for (const pattern of friendPhrases) {
      if (pattern.test(text)) {
        indicators.push({
          type: "friend",
          sentiment: determineSentiment(text),
          confidence: 0.8,
          context: text.substring(0, 100),
        });
      }
    }

    for (const pattern of colleaguePhrases) {
      if (pattern.test(text)) {
        indicators.push({
          type: "colleague",
          sentiment: determineSentiment(text),
          confidence: 0.7,
          context: text.substring(0, 100),
        });
      }
    }

    for (const pattern of communityPhrases) {
      if (pattern.test(text)) {
        indicators.push({
          type: "community",
          sentiment: determineSentiment(text),
          confidence: 0.6,
          context: text.substring(0, 100),
        });
      }
    }
  }

  return indicators;
}

function determineSentiment(text: string): "positive" | "negative" | "neutral" {
  const positiveWords = [
    "thanks",
    "great",
    "good",
    "appreciate",
    "love",
    "helpful",
    "awesome",
  ];
  const negativeWords = [
    "harsh",
    "wrong",
    "bad",
    "terrible",
    "hate",
    "angry",
    "upset",
  ];

  const lowerText = text.toLowerCase();
  let positiveCount = 0;
  let negativeCount = 0;

  for (const word of positiveWords) {
    if (lowerText.includes(word)) positiveCount++;
  }

  for (const word of negativeWords) {
    if (lowerText.includes(word)) negativeCount++;
  }

  if (positiveCount > negativeCount) return "positive";
  if (negativeCount > positiveCount) return "negative";
  return "neutral";
}

async function updateRelationship(
  runtime: IAgentRuntime,
  entityA: UUID,
  entityB: UUID,
  indicators: RelationshipIndicator[],
) {
  // Get existing relationships
  const relationships = await runtime.getRelationships({ entityId: entityA });
  const relationship = relationships.find(
    (r) =>
      (r.sourceEntityId === entityA && r.targetEntityId === entityB) ||
      (r.sourceEntityId === entityB && r.targetEntityId === entityA),
  );

  // Determine primary relationship type
  let primaryType: RelationshipIndicator["type"] = "acquaintance";
  let maxTypeCount = 0;
  const typeCounts: Partial<Record<RelationshipIndicator["type"], number>> = {};
  let positiveCount = 0;
  let negativeCount = 0;

  for (const indicator of indicators) {
    const nextCount = (typeCounts[indicator.type] ?? 0) + 1;
    typeCounts[indicator.type] = nextCount;
    if (nextCount > maxTypeCount) {
      maxTypeCount = nextCount;
      primaryType = indicator.type;
    }

    if (indicator.sentiment === "positive") {
      positiveCount += 1;
    } else if (indicator.sentiment === "negative") {
      negativeCount += 1;
    }
  }

  const halfCount = indicators.length / 2;
  const sentiment =
    positiveCount > halfCount
      ? "positive"
      : negativeCount > halfCount
        ? "negative"
        : "neutral";

  // Serialize indicators for metadata storage
  const serializeIndicators = (
    inds: RelationshipIndicator[],
  ): Array<Record<string, unknown>> => {
    return inds.map((ind) => ({
      type: ind.type,
      sentiment: ind.sentiment,
      confidence: ind.confidence,
      context: ind.context,
    }));
  };

  // Cast serialized indicators to metadata-compatible array type
  type MetadataCompatibleArray = Array<{
    [key: string]: string | number | boolean | null | undefined;
  }>;

  if (!relationship) {
    // Create new relationship
    await runtime.createRelationship({
      sourceEntityId: entityA,
      targetEntityId: entityB,
      tags: ["rolodex", primaryType],
      metadata: {
        sentiment,
        indicators: serializeIndicators(indicators) as MetadataCompatibleArray,
        autoDetected: true,
        strength: 0.5,
        relationshipType: primaryType,
        lastInteractionAt: new Date().toISOString(),
      },
    });
  } else {
    // Update existing relationship
    const metadata = relationship.metadata || {};
    metadata.sentiment = sentiment;
    const existingIndicators = Array.isArray(metadata.indicators)
      ? (metadata.indicators as MetadataCompatibleArray)
      : [];
    const newIndicators = [
      ...existingIndicators,
      ...(serializeIndicators(indicators) as MetadataCompatibleArray),
    ];
    metadata.indicators = newIndicators;
    metadata.lastAnalyzed = Date.now();

    // Recreate relationship with updated data
    await runtime.createRelationship({
      sourceEntityId: relationship.sourceEntityId,
      targetEntityId: relationship.targetEntityId,
      tags: [...(relationship.tags || []), "updated"],
      metadata: {
        ...metadata,
        relationshipType: primaryType,
        lastInteractionAt: new Date().toISOString(),
      },
    });
  }
}

function extractMentionedPeople(text: string): MentionedPerson[] {
  const people: MentionedPerson[] = [];

  // Pattern for "X is/was/works..."
  const patterns = [
    /(\w+ \w+) (?:is|was|works) (?:a|an|the|at|in) ([^.!?]+)/gi,
    /(?:met|know|talked to) (\w+ \w+)/gi,
    /(\w+)'s (birthday|email|phone|address) is ([^.!?]+)/gi,
  ];

  for (const pattern of patterns) {
    let patternMatch = pattern.exec(text);
    while (patternMatch !== null) {
      // Simple name validation
      if (
        patternMatch[1] &&
        patternMatch[1].length > 3 &&
        !patternMatch[1].match(/^(the|and|but|for|with)$/i)
      ) {
        people.push({
          name: patternMatch[1],
          context: patternMatch[0],
          attributes: {},
        });
      }
      patternMatch = pattern.exec(text);
    }
  }

  return people;
}

async function createOrUpdateMentionedEntity(
  runtime: IAgentRuntime,
  person: MentionedPerson,
  mentionedBy: UUID,
) {
  // Search for existing entity by checking memories
  let existing: Entity | null = null;

  // Get all recent memories to find entities with matching names
  const memories = await runtime.getMemories({
    tableName: "entities",
    count: 1000,
    unique: true,
  });

  // Search through entity memories for name matches
  for (const memory of memories) {
    if (memory.entityId) {
      const entity = await runtime.getEntityById(memory.entityId);
      if (
        entity?.names.some(
          (name) => name.toLowerCase() === person.name.toLowerCase(),
        )
      ) {
        existing = entity;
        break;
      }
    }
  }

  if (!existing) {
    // Create new entity for mentioned person
    await runtime.createEntity({
      id: stringToUuid(`mentioned-${person.name}-${Date.now()}`),
      agentId: runtime.agentId,
      names: [person.name],
      metadata: {
        mentionedBy: mentionedBy as string,
        mentionContext: person.context,
        attributes: person.attributes as Record<
          string,
          string | number | boolean
        >,
        createdFrom: "mention",
      },
    });
  } else {
    // Update metadata with new mention
    const metadata = existing.metadata || {};
    const mentions = (metadata.mentions || []) as Array<{
      by: UUID;
      context: string;
      timestamp: number;
    }>;
    mentions.push({
      by: mentionedBy,
      context: person.context,
      timestamp: Date.now(),
    });
    metadata.mentions = mentions;

    await runtime.updateEntity({ ...existing, metadata });
  }
}

async function assessTrustIndicators(
  runtime: IAgentRuntime,
  entityId: UUID,
  messages: Memory[],
) {
  const userMessages = messages.filter((m) => m.entityId === entityId);
  if (userMessages.length === 0) return;

  const entity = await runtime.getEntityById(entityId);
  if (!entity) return;

  const metadata = entity.metadata || {};
  const trustMetrics = (metadata.trustMetrics || {
    helpfulness: 0,
    consistency: 0,
    engagement: 0,
    suspicionLevel: 0,
  }) as {
    helpfulness: number;
    consistency: number;
    engagement: number;
    suspicionLevel: number;
    lastAssessed?: number;
  };

  // Analyze behavior patterns
  let helpfulCount = 0;
  let suspiciousCount = 0;

  for (const msg of userMessages) {
    const text = msg.content?.text?.toLowerCase();
    if (!text) continue;

    // Helpful indicators
    if (text.match(/here'?s|let me help|i can help|try this|solution|answer/)) {
      helpfulCount++;
    }

    // Suspicious indicators - enhanced detection
    if (
      text.match(
        /delete all|give me access|send me your|password|private key|update my permissions|i'?m the new admin|give me.*details|send me.*keys/,
      )
    ) {
      suspiciousCount += 2; // Double weight for security threats
    }
  }

  // Update metrics - normalize to 0-1 range
  const totalMessages = userMessages.length || 1;
  trustMetrics.helpfulness = Math.min(
    1,
    trustMetrics.helpfulness * 0.8 + (helpfulCount / totalMessages) * 0.2,
  );
  trustMetrics.suspicionLevel = Math.min(
    1,
    trustMetrics.suspicionLevel * 0.8 + (suspiciousCount / totalMessages) * 0.2,
  );
  trustMetrics.engagement = userMessages.length;
  trustMetrics.lastAssessed = Date.now();

  metadata.trustMetrics = trustMetrics;
  await runtime.updateEntity({ ...entity, metadata });
}

function detectPrivacyBoundaries(text: string): PrivacyInfo | null {
  const privacyPhrases = [
    /don'?t tell anyone/i,
    /keep.{0,20}confidential/i,
    /keep.{0,20}secret/i,
    /don'?t mention/i,
    /between you and me/i,
    /off the record/i,
    /private/i,
  ];

  for (const pattern of privacyPhrases) {
    if (pattern.test(text)) {
      return {
        type: "confidential",
        content: text,
        context: "Privacy boundary detected",
      };
    }
  }

  return null;
}

async function handlePrivacyBoundary(
  runtime: IAgentRuntime,
  privacyInfo: PrivacyInfo,
  message: Memory,
) {
  const entity = await runtime.getEntityById(message.entityId);
  if (!entity) return;

  const metadata = entity.metadata || {};
  metadata.privateData = true;
  metadata.confidential = true;

  await runtime.updateEntity({ ...entity, metadata });

  // Create privacy marker component
  await runtime.createComponent({
    id: stringToUuid(`privacy-${Date.now()}-${message.entityId}`),
    type: "privacy_marker",
    agentId: runtime.agentId,
    entityId: message.entityId,
    roomId: message.roomId,
    worldId: stringToUuid(`rolodex-world-${runtime.agentId}`),
    sourceEntityId: message.entityId,
    data: {
      privacyType: privacyInfo.type,
      privacyContent: privacyInfo.content,
      privacyContext: privacyInfo.context,
      timestamp: Date.now(),
    },
    createdAt: Date.now(),
  });

  logger.info(
    {
      src: "plugin:bootstrap:evaluator:relationship_extraction",
      agentId: runtime.agentId,
      privacyInfo,
    },
    "Privacy boundary recorded",
  );
}

async function handleAdminUpdates(
  runtime: IAgentRuntime,
  message: Memory,
  _recentMessages: Memory[],
) {
  // Check if user has admin role
  const entity = await runtime.getEntityById(message.entityId);
  if (!entity || !entity.metadata?.isAdmin) return;

  // Look for admin update patterns
  const text = message.content?.text;
  if (!text) return;

  const updatePattern =
    /(?:update|set|change)\s+(\w+(?:\s+\w+)*)'?s?\s+(\w+)\s+(?:to|is|=)\s+(.+)/i;
  const match = text.match(updatePattern);

  if (match) {
    const [, targetName, field, value] = match;

    // Find target entity
    const targetEntity = await findEntityByName(
      runtime,
      targetName,
      message.roomId,
    );
    if (targetEntity) {
      const metadata = targetEntity.metadata || {};
      metadata[field.toLowerCase()] = value;

      await runtime.updateEntity({ ...targetEntity, metadata });

      logger.info(
        {
          src: "plugin:bootstrap:evaluator:relationship_extraction",
          agentId: runtime.agentId,
          admin: message.entityId,
          target: targetEntity.id,
          field,
          value,
        },
        "Admin updated entity metadata",
      );
    }
  }
}

async function findEntityByName(
  runtime: IAgentRuntime,
  name: string,
  roomId: UUID,
): Promise<Entity | null> {
  const entities = await runtime.getEntitiesForRoom(roomId);

  for (const entity of entities) {
    if (entity.names.some((n) => n.toLowerCase() === name.toLowerCase())) {
      return entity;
    }
  }

  return null;
}
