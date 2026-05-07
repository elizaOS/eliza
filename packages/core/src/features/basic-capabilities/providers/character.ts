import { requireProviderSpec } from "../../../generated/spec-helpers.ts";
import type {
	IAgentRuntime,
	Memory,
	Provider,
	State,
} from "../../../types/index.ts";
import { ChannelType } from "../../../types/index.ts";
import {
	buildDeterministicSeed,
	deterministicPick,
	deterministicSample,
	getDeterministicNames,
} from "../../../utils/deterministic";
import { addHeader } from "../../../utils.ts";

// Get text content from centralized specs
const spec = requireProviderSpec("CHARACTER");

function resolveCharacterPlaceholders(
	text: string | undefined,
	agentName: string,
	exampleNames: string[] = [],
): string {
	let resolved = (text ?? "")
		.replaceAll("{{agentName}}", agentName)
		.replaceAll("{{name}}", agentName);

	exampleNames.forEach((name, index) => {
		const slot = index + 1;
		resolved = resolved
			.replaceAll(`{{name${slot}}}`, name)
			.replaceAll(`{{user${slot}}}`, name);
	});

	return resolved;
}

function resolveCharacterList(
	items: readonly (string | undefined)[] | undefined,
	agentName: string,
	exampleNames: string[] = [],
): string[] {
	return (items ?? []).flatMap((item) =>
		item === undefined
			? []
			: [resolveCharacterPlaceholders(item, agentName, exampleNames)],
	);
}

/**
 * Character provider object.
 * @typedef {Object} Provider
 * @property {string} name - The name of the provider ("CHARACTER").
 * @property {string} description - Description of the character information.
 * @property {Function} get - Async function to get character information.
 */
/**
 * Provides character information.
 * @param {IAgentRuntime} runtime - The agent runtime.
 * @param {Memory} message - The message memory.
 * @param {State} state - The state of the character.
 * @returns {Object} Object containing values, data, and text sections.
 */
export const characterProvider: Provider = {
	name: spec.name,
	description: spec.description,
	contexts: ["general", "agent_internal"],
	contextGate: { anyOf: ["general", "agent_internal"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "USER" },

	get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
		const character = runtime.character;
		const characterSeed = buildDeterministicSeed(
			runtime.agentId,
			message.roomId,
			"CHARACTER",
		);

		// Character name
		const agentName = character.name ?? "";

		// Handle bio (random selection from array)
		const bioArray = resolveCharacterList(character.bio ?? [], agentName);
		const bioText =
			bioArray.length > 0
				? deterministicSample(
						bioArray,
						10,
						buildDeterministicSeed(characterSeed, "bio"),
					).join(" ")
				: "";

		const bio = addHeader(`# About ${agentName}`, bioText);

		// System prompt
		const system = resolveCharacterPlaceholders(
			character.system ?? "",
			agentName,
		);

		// Select random topic if available
		const topicString =
			character.topics && character.topics.length > 0
				? resolveCharacterPlaceholders(
						deterministicPick(
							character.topics,
							buildDeterministicSeed(characterSeed, "topic"),
						),
						agentName,
					)
				: null;

		// postCreationTemplate in core prompts.ts
		// Write a post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from the perspective of {{agentName}}. Do not add commentary or acknowledge this request, just write the post.
		// Write a post that is {{Spartan is dirty}} about {{Spartan is currently}}
		const topic = topicString || "";

		// Format topics list
		const topics =
			character.topics && character.topics.length > 0
				? `${agentName} is also interested in ${deterministicSample(
						resolveCharacterList(character.topics, agentName).filter(
							(topic: string) => topic !== topicString,
						),
						5,
						buildDeterministicSeed(characterSeed, "topics"),
					)
						.map((topic, index, array) => {
							if (index === array.length - 2) {
								return `${topic} and `;
							}
							if (index === array.length - 1) {
								return topic;
							}
							return `${topic}, `;
						})
						.join("")}`
				: "";

		// Select random adjective if available
		const adjectiveString =
			character.adjectives && character.adjectives.length > 0
				? resolveCharacterPlaceholders(
						deterministicPick(
							character.adjectives,
							buildDeterministicSeed(characterSeed, "adjective"),
						),
						agentName,
					)
				: "";

		const adjective = adjectiveString || "";

		// Format post examples
		const postExamplesArray = character.postExamples ?? [];
		const formattedCharacterPostExamples =
			postExamplesArray.length > 0
				? deterministicSample(
						postExamplesArray,
						50,
						buildDeterministicSeed(characterSeed, "posts"),
					)
						.map((post) => resolveCharacterPlaceholders(`${post}`, agentName))
						.join("\n")
				: "";

		const characterPostExamples =
			formattedCharacterPostExamples &&
			formattedCharacterPostExamples.replaceAll("\n", "").length > 0
				? addHeader(
						`# Example Posts for ${agentName}`,
						formattedCharacterPostExamples,
					)
				: "";

		// Format message examples
		const messageExamplesArray = character.messageExamples ?? [];
		const formattedCharacterMessageExamples =
			messageExamplesArray.length > 0
				? deterministicSample(
						messageExamplesArray,
						5,
						buildDeterministicSeed(characterSeed, "message-examples"),
					)
						.map((group, index) => {
							const exampleNames = getDeterministicNames(
								5,
								buildDeterministicSeed(characterSeed, "participants", index),
							);

							return group.examples
								.map((message) => {
									const messageContent = message.content;
									const actionsText = messageContent?.actions?.join(", ");
									const text = messageContent?.text ?? "";
									const exampleText = resolveCharacterPlaceholders(
										text,
										agentName,
										exampleNames,
									);
									const messageString = `${resolveCharacterPlaceholders(
										message.name,
										agentName,
										exampleNames,
									)}: ${exampleText}${
										actionsText ? ` (actions: ${actionsText})` : ""
									}`;
									return messageString;
								})
								.join("\n");
						})
						.join("\n\n")
				: "";

		const characterMessageExamples =
			formattedCharacterMessageExamples &&
			formattedCharacterMessageExamples.replaceAll("\n", "").length > 0
				? addHeader(
						`# Example Conversations for ${agentName}`,
						formattedCharacterMessageExamples,
					)
				: "";

		const room = state.data.room ?? (await runtime.getRoom(message.roomId));

		const roomType = room?.type;
		const isPostFormat =
			roomType === ChannelType.FEED || roomType === ChannelType.THREAD;

		// Style directions
		const characterStyle = character.style;
		const characterStyleAll = resolveCharacterList(
			characterStyle?.all || [],
			agentName,
		);
		const characterStylePost = resolveCharacterList(
			characterStyle?.post || [],
			agentName,
		);
		const postDirections =
			characterStyleAll.length > 0 || characterStylePost.length > 0
				? addHeader(
						`# Post Directions for ${agentName}`,
						[...characterStyleAll, ...characterStylePost].join("\n"),
					)
				: "";

		const characterStyleChat = resolveCharacterList(
			characterStyle?.chat || [],
			agentName,
		);
		const messageDirections =
			characterStyleAll.length > 0 || characterStyleChat.length > 0
				? addHeader(
						`# Message Directions for ${agentName}`,
						[...characterStyleAll, ...characterStyleChat].join("\n"),
					)
				: "";

		const directions = isPostFormat ? postDirections : messageDirections;
		const examples = isPostFormat
			? characterPostExamples
			: characterMessageExamples;

		const values = {
			agentName,
			bio,
			system,
			topic,
			topics,
			adjective,
			messageDirections,
			postDirections,
			directions,
			examples,
			characterPostExamples,
			characterMessageExamples,
		};

		const data = {
			bio,
			adjective,
			topic,
			topics,
			character,
			directions,
			examples,
			system,
		};

		const topicSentence = topicString
			? `${agentName} is currently interested in ${topicString}`
			: "";
		const adjectiveSentence = adjectiveString
			? `${agentName} is ${adjectiveString}`
			: "";
		// Combine all text sections
		const text = [
			bio,
			adjectiveSentence,
			topicSentence,
			topics,
			directions,
			examples,
			system,
		]
			.filter(Boolean)
			.join("\n\n");

		return {
			values,
			data: {
				bio: data.bio,
				adjective: data.adjective,
				topic: data.topic,
				topics: data.topics,
				character: data.character,
				directions: data.directions,
				examples: data.examples,
				system: data.system,
			},
			text,
		};
	},
};
