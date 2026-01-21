import { requireProviderSpec } from "../../generated/spec-helpers.ts";
import type {
  IAgentRuntime,
  Memory,
  Provider,
  State,
} from "../../types/index.ts";
import { ChannelType } from "../../types/index.ts";
import { addHeader } from "../../utils.ts";

// Get text content from centralized specs
const spec = requireProviderSpec("CHARACTER");

function randomSample<T>(items: T[], count: number): T[] {
  const copy = items.slice();
  const max = Math.min(count, copy.length);
  for (let i = 0; i < max; i += 1) {
    const j = i + Math.floor(Math.random() * (copy.length - i));
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy.slice(0, max);
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
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    const character = runtime.character;

    // Character name
    const agentName = character.name;

    // Handle bio (random selection from array)
    const bioArray = character.bio ?? [];
    const bioText =
      bioArray.length > 0 ? randomSample(bioArray, 10).join(" ") : "";

    const bio = addHeader(`# About ${character.name}`, bioText);

    // System prompt
    const system = character.system ?? "";

    // Select random topic if available
    const topicString =
      character.topics && character.topics.length > 0
        ? character.topics[Math.floor(Math.random() * character.topics.length)]
        : null;

    // postCreationTemplate in core prompts.ts
    // Write a post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from the perspective of {{agentName}}. Do not add commentary or acknowledge this request, just write the post.
    // Write a post that is {{Spartan is dirty}} about {{Spartan is currently}}
    const topic = topicString || "";

    // Format topics list
    const topics =
      character.topics && character.topics.length > 0
        ? `${character.name} is also interested in ${randomSample(
            character.topics.filter((topic) => topic !== topicString),
            5,
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
        ? character.adjectives[
            Math.floor(Math.random() * character.adjectives.length)
          ]
        : "";

    const adjective = adjectiveString || "";

    // Format post examples
    const postExamplesArray = character.postExamples ?? [];
    const formattedCharacterPostExamples =
      postExamplesArray.length > 0
        ? randomSample(postExamplesArray, 50)
            .map((post) => `${post}`)
            .join("\n")
        : "";

    const characterPostExamples =
      formattedCharacterPostExamples &&
      formattedCharacterPostExamples.replaceAll("\n", "").length > 0
        ? addHeader(
            `# Example Posts for ${character.name}`,
            formattedCharacterPostExamples,
          )
        : "";

    // Format message examples
    const messageExamplesArray = character.messageExamples ?? [];
    const formattedCharacterMessageExamples =
      messageExamplesArray.length > 0
        ? randomSample(messageExamplesArray, 5)
            .map((group) => {
              const exampleNames = Array.from({ length: 5 }, () =>
                Math.random().toString(36).substring(2, 8),
              );

              return group.examples
                .map((message) => {
                  const messageContent = message.content;
                  const actionsText = messageContent?.actions?.join(", ");
                  const text = messageContent?.text ?? "";
                  let messageString = `${message.name}: ${text}${
                    actionsText ? ` (actions: ${actionsText})` : ""
                  }`;
                  exampleNames.forEach((name, index) => {
                    const placeholder = `{{name${index + 1}}}`;
                    messageString = messageString.replaceAll(placeholder, name);
                  });
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
            `# Example Conversations for ${character.name}`,
            formattedCharacterMessageExamples,
          )
        : "";

    const room = state.data.room ?? (await runtime.getRoom(message.roomId));

    const roomType = room?.type;
    const isPostFormat =
      roomType === ChannelType.FEED || roomType === ChannelType.THREAD;

    // Style directions
    const characterStyle = character.style;
    const characterStyleAll = characterStyle?.all;
    const characterStylePost = characterStyle?.post;
    const postDirections =
      (characterStyleAll && characterStyleAll.length > 0) ||
      (characterStylePost && characterStylePost.length > 0)
        ? addHeader(
            `# Post Directions for ${character.name}`,
            (() => {
              const all = characterStyleAll || [];
              const post = characterStylePost || [];
              return [...all, ...post].join("\n");
            })(),
          )
        : "";

    const characterStyleChat = characterStyle?.chat;
    const messageDirections =
      (characterStyleAll && characterStyleAll.length > 0) ||
      (characterStyleChat && characterStyleChat.length > 0)
        ? addHeader(
            `# Message Directions for ${character.name}`,
            (() => {
              const all = characterStyleAll || [];
              const chat = characterStyleChat || [];
              return [...all, ...chat].join("\n");
            })(),
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
      ? `${character.name} is currently interested in ${topicString}`
      : "";
    const adjectiveSentence = adjectiveString
      ? `${character.name} is ${adjectiveString}`
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
