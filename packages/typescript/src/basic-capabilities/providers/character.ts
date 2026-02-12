import {
  buildDeterministicSeed,
  deterministicHex,
  deterministicPickOne,
  deterministicSample,
} from "../../deterministic";
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

/**
 * Replace `{{name}}` placeholders in a string with the character's name.
 * Supports character template files where the name is injected at render time
 * so changing the character's name doesn't require rewriting every field.
 */
function resolveNamePlaceholder(text: string, name: string): string {
  return text.replaceAll("{{name}}", name);
}

/** Resolve `{{name}}` in every element of a string array. */
function resolveNameInArray(items: string[], name: string): string[] {
  return items.map((s) => resolveNamePlaceholder(s, name));
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
    const agentName = character.name ?? "";

    const room = state.data.room ?? (await runtime.getRoom(message.roomId));
    const deterministicSeed = buildDeterministicSeed([
      "provider:character",
      runtime.agentId,
      character.id ?? "character:none",
      room?.worldId ?? "world:none",
      room?.id ?? message.roomId ?? "room:none",
    ]);

    // Handle bio (random selection from array, resolve {{name}} placeholders)
    const rawBioArray = character.bio ?? [];
    const bioArray = resolveNameInArray(rawBioArray, agentName);
    const bioText =
      bioArray.length > 0
        ? deterministicSample(bioArray, 10, deterministicSeed, "bio").join(" ")
        : "";

    const bio = addHeader(`# About ${agentName}`, bioText);

    // System prompt (resolve {{name}} placeholders)
    const system = resolveNamePlaceholder(character.system ?? "", agentName);

    // Resolve {{name}} in topics
    const resolvedTopics = character.topics
      ? resolveNameInArray(character.topics, agentName)
      : [];

    // Select random topic if available
    const topicString =
      resolvedTopics.length > 0
        ? deterministicPickOne(
            resolvedTopics,
            deterministicSeed,
            "selected-topic",
          ) || null
        : null;

    // postCreationTemplate in core prompts.ts
    // Write a post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from the perspective of {{agentName}}. Do not add commentary or acknowledge this request, just write the post.
    // Write a post that is {{Spartan is dirty}} about {{Spartan is currently}}
    const topic = topicString || "";

    // Format topics list
    const topics =
      resolvedTopics.length > 0
        ? `${agentName} is also interested in ${deterministicSample(
            resolvedTopics.filter((t: string) => t !== topicString),
            5,
            deterministicSeed,
            "topic-list",
          )
            .map((t, index, array) => {
              if (index === array.length - 2) {
                return `${t} and `;
              }
              if (index === array.length - 1) {
                return t;
              }
              return `${t}, `;
            })
            .join("")}`
        : "";

    // Resolve {{name}} in adjectives and select random one
    const resolvedAdjectives = character.adjectives
      ? resolveNameInArray(character.adjectives, agentName)
      : [];
    const adjectiveString =
      resolvedAdjectives.length > 0
        ? deterministicPickOne(
            resolvedAdjectives,
            deterministicSeed,
            "selected-adjective",
          ) || ""
        : "";

    const adjective = adjectiveString || "";

    // Format post examples (resolve {{name}} placeholders)
    const postExamplesArray = character.postExamples
      ? resolveNameInArray(character.postExamples, agentName)
      : [];
    const formattedCharacterPostExamples =
      postExamplesArray.length > 0
        ? deterministicSample(
            postExamplesArray,
            50,
            deterministicSeed,
            "post-examples",
          )
            .map((post) => `${post}`)
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

    // Format message examples (resolve {{name}} placeholders)
    const messageExamplesArray = character.messageExamples ?? [];
    const formattedCharacterMessageExamples =
      messageExamplesArray.length > 0
        ? deterministicSample(
            messageExamplesArray,
            5,
            deterministicSeed,
            "message-examples",
          )
            .map((group, groupIndex) => {
              const exampleNames = Array.from(
                { length: 5 },
                (_unused, nameIndex) =>
                  deterministicHex(
                    deterministicSeed,
                    `message-example:${groupIndex}:name:${nameIndex}`,
                    8,
                  ),
              );

              return group.examples
                .map((message) => {
                  const messageContent = message.content;
                  const actionsText = messageContent?.actions?.join(", ");
                  const rawText = messageContent?.text ?? "";
                  // Resolve {{name}} in example text content
                  const text = resolveNamePlaceholder(rawText, agentName);
                  let messageString = `${resolveNamePlaceholder(message.name ?? "", agentName)}: ${text}${
                    actionsText ? ` (actions: ${actionsText})` : ""
                  }`;
                  exampleNames.forEach((exName, index) => {
                    const placeholder = `{{name${index + 1}}}`;
                    messageString = messageString.replaceAll(
                      placeholder,
                      exName,
                    );
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
            `# Example Conversations for ${agentName}`,
            formattedCharacterMessageExamples,
          )
        : "";

    const roomType = room?.type;
    const isPostFormat =
      roomType === ChannelType.FEED || roomType === ChannelType.THREAD;

    // Style directions (resolve {{name}} placeholders)
    const characterStyle = character.style;
    const characterStyleAll = characterStyle?.all
      ? resolveNameInArray(characterStyle.all, agentName)
      : [];
    const characterStylePost = characterStyle?.post
      ? resolveNameInArray(characterStyle.post, agentName)
      : [];
    const postDirections =
      characterStyleAll.length > 0 || characterStylePost.length > 0
        ? addHeader(
            `# Post Directions for ${agentName}`,
            [...characterStyleAll, ...characterStylePost].join("\n"),
          )
        : "";

    const characterStyleChat = characterStyle?.chat
      ? resolveNameInArray(characterStyle.chat, agentName)
      : [];
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
