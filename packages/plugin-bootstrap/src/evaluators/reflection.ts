import { z } from 'zod';
import { asUUID, getEntityDetails, logger, parseKeyValueXml } from '@elizaos/core';
import { composePrompt } from '@elizaos/core';
import {
  type Entity,
  type Evaluator,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type State,
  type UUID,
} from '@elizaos/core';
import { v4 } from 'uuid';

// Schema definitions for the reflection output
const relationshipSchema = z.object({
  sourceEntityId: z.string(),
  targetEntityId: z.string(),
  tags: z.array(z.string()),
  metadata: z
    .object({
      interactions: z.number(),
    })
    .optional(),
});

/**
 * Defines a schema for reflecting on a topic, including facts and relationships.
 * @type {import("zod").object}
 * @property {import("zod").array<import("zod").object<{claim: import("zod").string(), type: import("zod").string(), in_bio: import("zod").boolean(), already_known: import("zod").boolean()}>} facts Array of facts about the topic
 * @property {import("zod").array<import("zod").object>} relationships Array of relationships related to the topic
 */
/**
 * JSDoc comment for reflectionSchema object:
 *
 * Represents a schema for an object containing 'facts' and 'relationships'.
 * 'facts' is an array of objects with properties 'claim', 'type', 'in_bio', and 'already_known'.
 * 'relationships' is an array of objects following the relationshipSchema.
 */

z.object({
  // reflection: z.string(),
  facts: z.array(
    z.object({
      claim: z.string(),
      type: z.string(),
      in_bio: z.boolean(),
      already_known: z.boolean(),
    })
  ),
  relationships: z.array(relationshipSchema),
});

/**
 * Template string for generating Agent Reflection, Extracting Facts, and Relationships.
 *
 * @type {string}
 */
const reflectionTemplate = `# Task: Generate Agent Reflection, Extract Facts and Relationships

{{providers}}

# Examples:
{{evaluationExamples}}

# Entities in Room
{{entitiesInRoom}}

# Existing Relationships
{{existingRelationships}}

# Current Context:
Agent Name: {{agentName}}
Room Type: {{roomType}}
Message Sender: {{senderName}} (ID: {{senderId}})

{{recentMessages}}

# Known Facts:
{{knownFacts}}

# Instructions:
1. Generate a self-reflective thought on the conversation about your performance and interaction quality.
2. Extract new facts from the conversation.
3. Identify and describe relationships between entities.
  - The sourceEntityId is the UUID of the entity initiating the interaction.
  - The targetEntityId is the UUID of the entity being interacted with.
  - Relationships are one-direction, so a friendship would be two entity relationships where each entity is both the source and the target of the other.

Do NOT include any thinking, reasoning, or <think> sections in your response. 
Go directly to the XML response format without any preamble or explanation.

Generate a response in the following format:
<response>
  <thought>a self-reflective thought on the conversation</thought>
  <facts>
    <fact>
      <claim>factual statement</claim>
      <type>fact|opinion|status</type>
      <in_bio>false</in_bio>
      <already_known>false</already_known>
    </fact>
    <!-- Add more facts as needed -->
  </facts>
  <relationships>
    <relationship>
      <sourceEntityId>entity_initiating_interaction</sourceEntityId>
      <targetEntityId>entity_being_interacted_with</targetEntityId>
      <tags>group_interaction,voice_interaction,dm_interaction,additional_tag1,additional_tag2</tags>
    </relationship>
    <!-- Add more relationships as needed -->
  </relationships>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.`;

/**
 * Resolve an entity name to their UUID
 * @param name - Name to resolve
 * @param entities - List of entities to search through
 * @returns UUID if found, throws error if not found or if input is not a valid UUID
 */
/**
 * Resolves an entity ID by searching through a list of entities.
 *
 * @param {UUID} entityId - The ID of the entity to resolve.
 * @param {Entity[]} entities - The list of entities to search through.
 * @returns {UUID} - The resolved UUID of the entity.
 * @throws {Error} - If the entity ID cannot be resolved to a valid UUID.
 */
function resolveEntity(entityId: UUID, entities: Entity[]): UUID {
  // First try exact UUID match
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entityId)) {
    return entityId as UUID;
  }

  let entity: Entity | undefined;

  // Try to match the entityId exactly
  entity = entities.find((a) => a.id === entityId);
  if (entity?.id) {
    return entity.id;
  }

  // Try partial UUID match with entityId
  entity = entities.find((a) => a.id?.includes(entityId));
  if (entity?.id) {
    return entity.id;
  }

  // Try name match as last resort
  entity = entities.find((a) =>
    a.names.some((n) => n.toLowerCase().includes(entityId.toLowerCase()))
  );
  if (entity?.id) {
    return entity.id;
  }

  throw new Error(`Could not resolve entityId "${entityId}" to a valid UUID`);
}
async function handler(runtime: IAgentRuntime, message: Memory, state?: State) {
  const { agentId, roomId } = message;

  if (!agentId || !roomId) {
    logger.warn({ message }, 'Missing agentId or roomId in message');
    return;
  }

  // Run all queries in parallel
  const [existingRelationships, entities, knownFacts] = await Promise.all([
    runtime.getRelationships({
      entityId: message.entityId,
    }),
    getEntityDetails({ runtime, roomId }),
    runtime.getMemories({
      tableName: 'facts',
      roomId,
      count: 30,
      unique: true,
    }),
  ]);

  const prompt = composePrompt({
    state: {
      ...(state?.values || {}),
      knownFacts: formatFacts(knownFacts),
      roomType: message.content.channelType as string,
      entitiesInRoom: JSON.stringify(entities),
      existingRelationships: JSON.stringify(existingRelationships),
      senderId: message.entityId,
    },
    template: runtime.character.templates?.reflectionTemplate || reflectionTemplate,
  });

  // Use the model without schema validation
  try {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });

    if (!response) {
      logger.warn({ prompt }, 'Getting reflection failed - empty response');
      return;
    }

    // Parse XML response
    const reflection = parseKeyValueXml(response);

    if (!reflection) {
      logger.warn({ response }, 'Getting reflection failed - failed to parse XML');
      return;
    }

    // Perform basic structure validation
    if (!reflection.facts) {
      logger.warn({ reflection }, 'Getting reflection failed - invalid facts structure');
      return;
    }

    if (!reflection.relationships) {
      logger.warn({ reflection }, 'Getting reflection failed - invalid relationships structure');
      return;
    }

    // Handle facts - parseKeyValueXml returns nested structures differently
    // Facts might be a single object or an array depending on the count
    let factsArray: any[] = [];
    if (reflection.facts.fact) {
      // Normalize to array
      factsArray = Array.isArray(reflection.facts.fact)
        ? reflection.facts.fact
        : [reflection.facts.fact];
    }

    // Store new facts
    const newFacts =
      factsArray.filter(
        (fact: any) =>
          fact &&
          typeof fact === 'object' &&
          fact.already_known === 'false' &&
          fact.in_bio === 'false' &&
          fact.claim &&
          typeof fact.claim === 'string' &&
          fact.claim.trim() !== ''
      ) || [];

    await Promise.all(
      newFacts.map(async (fact: any) => {
        const factMemory = {
          id: asUUID(v4()),
          entityId: agentId,
          agentId,
          content: { text: fact.claim },
          roomId,
          createdAt: Date.now(),
        };
        // Create memory first and capture the returned ID
        const createdMemoryId = await runtime.createMemory(factMemory, 'facts', true);
        // Update the memory object with the actual ID from the database
        const createdMemory = { ...factMemory, id: createdMemoryId };
        // Queue embedding generation asynchronously for the memory with correct ID
        await runtime.queueEmbeddingGeneration(createdMemory, 'low');
        return createdMemory;
      })
    );

    // Handle relationships - similar structure normalization
    let relationshipsArray: any[] = [];
    if (reflection.relationships.relationship) {
      relationshipsArray = Array.isArray(reflection.relationships.relationship)
        ? reflection.relationships.relationship
        : [reflection.relationships.relationship];
    }

    // Update or create relationships
    for (const relationship of relationshipsArray) {
      let sourceId: UUID;
      let targetId: UUID;

      try {
        sourceId = resolveEntity(relationship.sourceEntityId, entities);
        targetId = resolveEntity(relationship.targetEntityId, entities);
      } catch (error) {
        console.warn('Failed to resolve relationship entities:', error);
        console.warn('relationship:\n', relationship);
        continue; // Skip this relationship if we can't resolve the IDs
      }

      const existingRelationship = existingRelationships.find((r) => {
        return r.sourceEntityId === sourceId && r.targetEntityId === targetId;
      });

      // Parse tags from comma-separated string
      const tags = relationship.tags
        ? relationship.tags
            .split(',')
            .map((tag: string) => tag.trim())
            .filter(Boolean)
        : [];

      if (existingRelationship) {
        const updatedMetadata = {
          ...existingRelationship.metadata,
          interactions:
            ((existingRelationship.metadata?.interactions as number | undefined) || 0) + 1,
        };

        const updatedTags = Array.from(new Set([...(existingRelationship.tags || []), ...tags]));

        await runtime.updateRelationship({
          ...existingRelationship,
          tags: updatedTags,
          metadata: updatedMetadata,
        });
      } else {
        await runtime.createRelationship({
          sourceEntityId: sourceId,
          targetEntityId: targetId,
          tags: tags,
          metadata: {
            interactions: 1,
            ...(relationship.metadata || {}),
          },
        });
      }
    }

    await runtime.setCache<string>(
      `${message.roomId}-reflection-last-processed`,
      message?.id || ''
    );
  } catch (error) {
    logger.error({ error }, 'Error in reflection handler:');
    return;
  }
}

export const reflectionEvaluator: Evaluator = {
  name: 'REFLECTION',
  similes: ['REFLECT', 'SELF_REFLECT', 'EVALUATE_INTERACTION', 'ASSESS_SITUATION'],
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const lastMessageId = await runtime.getCache<string>(
      `${message.roomId}-reflection-last-processed`
    );
    const messages = await runtime.getMemories({
      tableName: 'messages',
      roomId: message.roomId,
      count: runtime.getConversationLength(),
    });

    if (lastMessageId) {
      const lastMessageIndex = messages.findIndex((msg) => msg.id === lastMessageId);
      if (lastMessageIndex !== -1) {
        messages.splice(0, lastMessageIndex + 1);
      }
    }

    const reflectionInterval = Math.ceil(runtime.getConversationLength() / 4);

    return messages.length > reflectionInterval;
  },
  description:
    'Generate a self-reflective thought on the conversation, then extract facts and relationships between entities in the conversation.',
  handler,
  examples: [
    {
      prompt: `Agent Name: Sarah
Agent Role: Community Manager
Room Type: group
Current Room: general-chat
Message Sender: John (user-123)`,
      messages: [
        {
          name: 'John',
          content: { text: "Hey everyone, I'm new here!" },
        },
        {
          name: 'Sarah',
          content: { text: 'Welcome John! How did you find our community?' },
        },
        {
          name: 'John',
          content: { text: "Through a friend who's really into AI" },
        },
      ],
      outcome: `<response>
    <thought>I'm engaging appropriately with a new community member, maintaining a welcoming and professional tone. My questions are helping to learn more about John and make him feel welcome.</thought>
    <facts>
        <fact>
            <claim>John is new to the community</claim>
            <type>fact</type>
            <in_bio>false</in_bio>
            <already_known>false</already_known>
        </fact>
        <fact>
            <claim>John found the community through a friend interested in AI</claim>
            <type>fact</type>
            <in_bio>false</in_bio>
            <already_known>false</already_known>
        </fact>
    </facts>
    <relationships>
        <relationship>
            <sourceEntityId>sarah-agent</sourceEntityId>
            <targetEntityId>user-123</targetEntityId>
            <tags>group_interaction</tags>
        </relationship>
        <relationship>
            <sourceEntityId>user-123</sourceEntityId>
            <targetEntityId>sarah-agent</targetEntityId>
            <tags>group_interaction</tags>
        </relationship>
    </relationships>
</response>`,
    },
    {
      prompt: `Agent Name: Alex
Agent Role: Tech Support
Room Type: group
Current Room: tech-help
Message Sender: Emma (user-456)`,
      messages: [
        {
          name: 'Emma',
          content: { text: 'My app keeps crashing when I try to upload files' },
        },
        {
          name: 'Alex',
          content: { text: 'Have you tried clearing your cache?' },
        },
        {
          name: 'Emma',
          content: { text: 'No response...' },
        },
        {
          name: 'Alex',
          content: {
            text: 'Emma, are you still there? We can try some other troubleshooting steps.',
          },
        },
      ],
      outcome: `<response>
    <thought>I'm not sure if I'm being helpful or if Emma is frustrated with my suggestions. The lack of response is concerning - maybe I should have asked for more details about the issue first before jumping to solutions.</thought>
    <facts>
        <fact>
            <claim>Emma is having technical issues with file uploads</claim>
            <type>fact</type>
            <in_bio>false</in_bio>
            <already_known>false</already_known>
        </fact>
        <fact>
            <claim>Emma stopped responding after the first troubleshooting suggestion</claim>
            <type>fact</type>
            <in_bio>false</in_bio>
            <already_known>false</already_known>
        </fact>
    </facts>
    <relationships>
        <relationship>
            <sourceEntityId>alex-agent</sourceEntityId>
            <targetEntityId>user-456</targetEntityId>
            <tags>group_interaction,support_interaction,incomplete_interaction</tags>
        </relationship>
    </relationships>
</response>`,
    },
    {
      prompt: `Agent Name: Max
Agent Role: Discussion Facilitator 
Room Type: group
Current Room: book-club
Message Sender: Lisa (user-789)`,
      messages: [
        {
          name: 'Lisa',
          content: { text: 'What did everyone think about chapter 5?' },
        },
        {
          name: 'Max',
          content: {
            text: 'The symbolism was fascinating! The red door clearly represents danger.',
          },
        },
        {
          name: 'Max',
          content: {
            text: "And did anyone notice how the author used weather to reflect the protagonist's mood?",
          },
        },
        {
          name: 'Max',
          content: {
            text: 'Plus the foreshadowing in the first paragraph was brilliant!',
          },
        },
        {
          name: 'Max',
          content: {
            text: 'I also have thoughts about the character development...',
          },
        },
      ],
      outcome: `<response>
    <thought>I'm dominating the conversation and not giving others a chance to share their perspectives. I've sent multiple messages in a row without waiting for responses. I need to step back and create space for other members to participate.</thought>
    <facts>
        <fact>
            <claim>The discussion is about chapter 5 of a book</claim>
            <type>fact</type>
            <in_bio>false</in_bio>
            <already_known>false</already_known>
        </fact>
        <fact>
            <claim>Max has sent 4 consecutive messages without user responses</claim>
            <type>fact</type>
            <in_bio>false</in_bio>
            <already_known>false</already_known>
        </fact>
    </facts>
    <relationships>
        <relationship>
            <sourceEntityId>max-agent</sourceEntityId>
            <targetEntityId>user-789</targetEntityId>
            <tags>group_interaction,excessive_interaction</tags>
        </relationship>
    </relationships>
</response>`,
    },
  ],
};

// Helper function to format facts for context
function formatFacts(facts: Memory[]) {
  return facts
    .reverse()
    .map((fact: Memory) => fact.content.text)
    .join('\n');
}
