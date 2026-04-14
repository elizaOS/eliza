import { getEntityDetails } from "../../../entities.ts";
import { logger } from "../../../logger.ts";
import {
	type Entity,
	type Evaluator,
	type IAgentRuntime,
	type JsonObject,
	type JsonValue,
	type Memory,
	ModelType,
	type State,
	type UUID,
} from "../../../types/index.ts";
import { composePrompt } from "../../../utils.ts";

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

Generate a response in the following format:
\`\`\`json
{
  "thought": "a self-reflective thought on the conversation",
  "facts": [
      {
          "claim": "factual statement",
          "type": "fact|opinion|status",
          "in_bio": false,
          "already_known": false
      }
  ],
  "relationships": [
      {
          "sourceEntityId": "entity_initiating_interaction",
          "targetEntityId": "entity_being_interacted_with",
          "tags": ["group_interaction|voice_interaction|dm_interaction", "additional_tag1", "additional_tag2"]
      }
  ]
}
\`\`\``;

function resolveEntity(entityId: UUID, entities: Entity[]): UUID {
	if (
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			entityId,
		)
	) {
		return entityId as UUID;
	}

	let entity: Entity | undefined;

	entity = entities.find((a) => a.id === entityId);
	if (entity?.id) {
		return entity.id;
	}

	entity = entities.find((a) => a.id?.includes(entityId));
	if (entity?.id) {
		return entity.id;
	}

	entity = entities.find((a) =>
		a.names.some((n) => n.toLowerCase().includes(entityId.toLowerCase())),
	);
	if (entity?.id) {
		return entity.id;
	}

	throw new Error(`Could not resolve entityId "${entityId}" to a valid UUID`);
}

async function handler(runtime: IAgentRuntime, message: Memory, state?: State) {
	const { agentId, roomId } = message;

	if (!agentId || !roomId) {
		logger.warn({ message }, "Missing agentId or roomId in message");
		return;
	}

	const [existingRelationships, entities, knownFacts] = await Promise.all([
		runtime.getRelationships({
			entityIds: message.entityId ? [message.entityId] : undefined,
		}),
		getEntityDetails({ runtime, roomId }),
		runtime.getMemories({
			tableName: "facts",
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
		template:
			runtime.character.templates?.reflectionTemplate || reflectionTemplate,
	});

	try {
		const reflection = await runtime.useModel(ModelType.OBJECT_SMALL, {
			prompt,
		});

		if (!reflection) {
			logger.warn({ prompt }, "Getting reflection failed - empty response");
			return;
		}

		if (!reflection.facts || !Array.isArray(reflection.facts)) {
			logger.warn(
				{ reflection },
				"Getting reflection failed - invalid facts structure",
			);
			return;
		}

		if (!reflection.relationships || !Array.isArray(reflection.relationships)) {
			logger.warn(
				{ reflection },
				"Getting reflection failed - invalid relationships structure",
			);
			return;
		}

		const newFacts =
			reflection.facts.filter(
				(fact): fact is JsonObject =>
					fact != null &&
					typeof fact === "object" &&
					!Array.isArray(fact) &&
					!fact.already_known &&
					!fact.in_bio &&
					typeof fact.claim === "string" &&
					fact.claim.trim() !== "",
			) || [];

		await Promise.all(
			newFacts.map(async (fact) => {
				const claim = fact.claim as string;
				const factMemory = await runtime.addEmbeddingToMemory({
					entityId: agentId,
					agentId,
					content: { text: claim },
					roomId,
					createdAt: Date.now(),
				});
				return runtime.createMemory(factMemory, "facts", true);
			}),
		);

		for (const rawRelationship of reflection.relationships) {
			if (
				!rawRelationship ||
				typeof rawRelationship !== "object" ||
				Array.isArray(rawRelationship)
			) {
				continue;
			}

			const relationship = rawRelationship as JsonObject;
			if (
				typeof relationship.sourceEntityId !== "string" ||
				typeof relationship.targetEntityId !== "string" ||
				!Array.isArray(relationship.tags)
			) {
				continue;
			}

			const tags = relationship.tags.filter(
				(t): t is string => typeof t === "string",
			);

			let sourceId: UUID;
			let targetId: UUID;

			try {
				sourceId = resolveEntity(relationship.sourceEntityId as UUID, entities);
				targetId = resolveEntity(relationship.targetEntityId as UUID, entities);
			} catch (error) {
				logger.warn({ error }, "Failed to resolve relationship entities");
				logger.warn({ relationship }, "Unresolved relationship");
				continue;
			}

			const existingRelationship = existingRelationships.find((r) => {
				return r.sourceEntityId === sourceId && r.targetEntityId === targetId;
			});

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
				const metadata =
					relationship.metadata != null &&
					typeof relationship.metadata === "object" &&
					!Array.isArray(relationship.metadata)
						? (relationship.metadata as Record<string, JsonValue>)
						: {};

				await runtime.createRelationship({
					sourceEntityId: sourceId,
					targetEntityId: targetId,
					tags,
					metadata: {
						interactions: 1,
						...metadata,
					},
				});
			}
		}

		await runtime.setCache<string>(
			`${message.roomId}-reflection-last-processed`,
			message?.id || "",
		);

		return {
			success: true,
			text: typeof reflection.thought === "string" ? reflection.thought : "",
		};
	} catch (error) {
		logger.error({ error }, "Error in reflection handler:");
		return;
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
			outcome: `{
    "thought": "I'm engaging appropriately with a new community member, maintaining a welcoming and professional tone.",
    "facts": [
        {
            "claim": "John is new to the community",
            "type": "fact",
            "in_bio": false,
            "already_known": false
        },
        {
            "claim": "John found the community through a friend interested in AI",
            "type": "fact",
            "in_bio": false,
            "already_known": false
        }
    ],
    "relationships": [
        {
            "sourceEntityId": "sarah-agent",
            "targetEntityId": "user-123",
            "tags": ["group_interaction"]
        },
        {
            "sourceEntityId": "user-123",
            "targetEntityId": "sarah-agent",
            "tags": ["group_interaction"]
        }
    ]
}`,
		},
	],
};

function formatFacts(facts: Memory[]) {
	return facts
		.reverse()
		.map((fact: Memory) => fact.content.text)
		.join("\n");
}
