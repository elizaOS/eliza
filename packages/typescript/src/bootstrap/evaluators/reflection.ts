import { v4 } from "uuid";
import { getEntityDetails } from "../../entities.ts";
import type {
  ActionResult,
  Entity,
  Evaluator,
  IAgentRuntime,
  Memory,
  UUID,
} from "../../types/index.ts";
import { asUUID } from "../../types/index.ts";

/** Shape of a single fact in the XML response */
interface FactXml {
  claim?: string;
  type?: string;
  in_bio?: boolean | string;
  already_known?: boolean | string;
}

/** Shape of a single relationship in the XML response */
interface RelationshipXml {
  sourceEntityId?: string;
  targetEntityId?: string;
  tags?: string[] | string;
  metadata?: Record<string, unknown>;
}

/** Shape of the batcher result fields for reflection. Used as generic T in onDrain<T> so result.fields is typed. WHY: Avoids casting; runtime still returns Record<string, unknown> from the model. */
interface ReflectionFields {
  facts: FactXml[];
  relationships: RelationshipXml[];
}

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
function resolveEntity(entityId: string, entities: Entity[]): UUID {
  // First try exact UUID match
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      entityId,
    )
  ) {
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
    a.names.some((n: string) =>
      n.toLowerCase().includes(entityId.toLowerCase()),
    ),
  );
  if (entity?.id) {
    return entity.id;
  }

  throw new Error(`Could not resolve entityId "${entityId}" to a valid UUID`);
}
async function handler(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<ActionResult | undefined> {
  const { agentId, roomId } = message;

  if (!agentId || !roomId) {
    runtime.logger.warn(
      {
        src: "plugin:bootstrap:evaluator:reflection",
        agentId: runtime.agentId,
        message,
      },
      "Missing agentId or roomId in message",
    );
    return undefined;
  }

  // Register a per-drain section and await the first result. WHY: Thenable API gives linear
  // flow (await + if (result)) instead of a large onResult callback; result is null when the
  // section ID was already registered (e.g. duplicate message), so we skip processing.
  const result = await runtime.promptBatcher.onDrain<ReflectionFields>(`reflection-${message.roomId}`, {
    providers: ["*"],
    room: String(message.roomId),
    model: "small",
    preamble: [
      "Reflect on the recent conversation and extract structured memory signals.",
      "Populate the `facts` field with fact entries containing claim, type, in_bio, and already_known.",
      "Populate the `relationships` field with relationship entries containing sourceEntityId, targetEntityId, tags, and metadata.",
      "Use entity IDs when available in context.",
      "Be conservative. Do not invent facts or relationships.",
      "For `in_bio` and `already_known`, use boolean values.",
    ].join("\n"),
    schema: [
      {
        field: "facts",
        description: "Fact entries describing claims from the conversation.",
        type: "array",
        required: true,
        items: {
          description: "One fact entry",
          type: "object",
          properties: [
            {
              field: "claim",
              description: "Fact claim extracted from the conversation",
              required: true,
            },
            {
              field: "type",
              description: "fact|opinion|preference",
              required: true,
            },
            {
              field: "in_bio",
              description: "Whether this fact is already present in the bio",
              type: "boolean",
              required: true,
            },
            {
              field: "already_known",
              description: "Whether this fact is already known from memory",
              type: "boolean",
              required: true,
            },
          ],
        },
      },
      {
        field: "relationships",
        description:
          "Relationship entries connecting entities from the conversation.",
        type: "array",
        required: true,
        items: {
          description: "One relationship entry",
          type: "object",
          properties: [
            {
              field: "sourceEntityId",
              description: "Source entity ID",
              required: true,
            },
            {
              field: "targetEntityId",
              description: "Target entity ID",
              required: true,
            },
            {
              field: "tags",
              description: "Relationship tags",
              type: "array",
              items: {
                description: "One relationship tag",
                type: "string",
              },
            },
            {
              field: "metadata",
              description: "Additional relationship metadata",
              type: "object",
              properties: [
                {
                  field: "interactions",
                  description: "Interaction count",
                  type: "number",
                },
              ],
            },
          ],
        },
      },
    ],
    fallback: {
      facts: [],
      relationships: [],
    },
  });

  if (result) {
    const { fields, meta } = result;
    const [existingRelationships, entities] = await Promise.all([
      runtime.getRelationships({
        entityIds: [message.entityId],
      }),
      getEntityDetails({ runtime, roomId }),
    ]);

    const factsArray = Array.isArray(fields.facts) ? fields.facts : [];
    const newFacts = factsArray.filter(
      (fact): fact is FactXml & { claim: string } =>
        fact != null &&
        fact.already_known !== true &&
        fact.already_known !== "true" &&
        fact.in_bio !== true &&
        fact.in_bio !== "true" &&
        typeof fact.claim === "string" &&
        fact.claim.trim() !== "",
    );

    await Promise.all(
      newFacts.map(async (fact) => {
        const factMemory = {
          id: asUUID(v4()),
          entityId: agentId,
          agentId,
          content: { text: fact.claim },
          roomId,
          createdAt: Date.now(),
        } as Memory;
        const createdMemoryId = await runtime.createMemory(
          factMemory,
          "facts",
          true,
        );
        const createdMemory = { ...factMemory, id: createdMemoryId };
        await runtime.queueEmbeddingGeneration(createdMemory, "low");
        return createdMemory;
      }),
    );

    const relationshipsArray = Array.isArray(fields.relationships) ? fields.relationships : [];
    for (const relationship of relationshipsArray) {
      if (!relationship.sourceEntityId || !relationship.targetEntityId) {
        runtime.logger.warn(
          {
            src: "plugin:bootstrap:evaluator:reflection",
            agentId: runtime.agentId,
            relationship,
          },
          "Skipping reflection relationship with missing entity IDs",
        );
        continue;
      }

      let sourceId: UUID;
      let target: UUID;

      try {
        sourceId = resolveEntity(relationship.sourceEntityId, entities);
        target = resolveEntity(relationship.targetEntityId, entities);
      } catch (error) {
        runtime.logger.warn(
          {
            src: "plugin:bootstrap:evaluator:reflection",
            agentId: runtime.agentId,
            relationship,
            error,
          },
          "Failed to resolve reflection relationship entities",
        );
        continue;
      }

      const existingRelationship = existingRelationships.find((r) => {
        return r.sourceEntityId === sourceId && r.targetEntityId === target;
      });

      const tags = Array.isArray(relationship.tags)
        ? relationship.tags
            .map((tag) => String(tag).trim())
            .filter(Boolean)
        : typeof relationship.tags === "string"
          ? relationship.tags
              .split(",")
              .map((tag: string) => tag.trim())
              .filter(Boolean)
          : [];

      if (existingRelationship) {
        const updatedMetadata = {
          ...existingRelationship.metadata,
          interactions:
            ((existingRelationship.metadata?.interactions as
              | number
              | undefined) || 0) + 1,
        };

        const updatedTags = Array.from(
          new Set([...(existingRelationship.tags || []), ...tags]),
        );

        await runtime.updateRelationship({
          ...existingRelationship,
          tags: updatedTags,
          metadata: updatedMetadata,
        });
      } else {
        await runtime.createRelationship({
          sourceEntityId: sourceId,
          targetEntityId: target,
          tags,
          metadata: {
            interactions: 1,
            ...(relationship.metadata || {}),
          },
        });
      }
    }

    const lastProcessedMessage = meta.messages.at(-1)?.id ?? message.id ?? "";
    await runtime.setCache<string>(
      `${message.roomId}-reflection-last-processed`,
      lastProcessedMessage,
    );
  }
}

export const reflectionEvaluator: Evaluator = {
  name: "REFLECTION",
  similes: [
    "REFLECT",
    "SELF_REFLECT",
    "EVALUATE_INTERACTION",
    "ASSESS_SITUATION",
  ],
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const lastMessageId = await runtime.getCache<string>(
      `${message.roomId}-reflection-last-processed`,
    );
    const messages = await runtime.getMemories({
      tableName: "messages",
      roomId: message.roomId,
      count: runtime.getConversationLength(),
    });

    if (lastMessageId) {
      const lastMessageIndex = messages.findIndex(
        (msg) => msg.id === lastMessageId,
      );
      if (lastMessageIndex !== -1) {
        messages.splice(0, lastMessageIndex + 1);
      }
    }

    const reflectionInterval = Math.ceil(runtime.getConversationLength() / 4);

    return messages.length > reflectionInterval;
  },
  description:
    "Generate a self-reflective thought on the conversation, then extract facts and relationships between entities in the conversation.",
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
          name: "John",
          content: { text: "Hey everyone, I'm new here!" },
        },
        {
          name: "Sarah",
          content: { text: "Welcome John! How did you find our community?" },
        },
        {
          name: "John",
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
          name: "Emma",
          content: { text: "My app keeps crashing when I try to upload files" },
        },
        {
          name: "Alex",
          content: { text: "Have you tried clearing your cache?" },
        },
        {
          name: "Emma",
          content: { text: "No response..." },
        },
        {
          name: "Alex",
          content: {
            text: "Emma, are you still there? We can try some other troubleshooting steps.",
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
          name: "Lisa",
          content: { text: "What did everyone think about chapter 5?" },
        },
        {
          name: "Max",
          content: {
            text: "The symbolism was fascinating! The red door clearly represents danger.",
          },
        },
        {
          name: "Max",
          content: {
            text: "And did anyone notice how the author used weather to reflect the protagonist's mood?",
          },
        },
        {
          name: "Max",
          content: {
            text: "Plus the foreshadowing in the first paragraph was brilliant!",
          },
        },
        {
          name: "Max",
          content: {
            text: "I also have thoughts about the character development...",
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
