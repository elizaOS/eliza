import type { IAgentRuntime, Memory, Provider, State } from '@elizaos/core';
import { addHeader, ChannelType } from '@elizaos/core';
import { getCachedRoom } from './shared-cache';

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
  name: 'CHARACTER',
  description: 'Character information',
  get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
    const character = runtime.character;

    // Use shared cache for room lookup - this ensures all providers share the same
    // in-flight promise and cached result, preventing redundant DB calls
    const room = message.roomId ? await getCachedRoom(runtime, message.roomId) : null;
    const isPostFormat = room?.type === ChannelType.FEED || room?.type === ChannelType.THREAD;

    // Character name
    const agentName = character.name;

    // Handle bio (string or random selection from array)
    const bioText = Array.isArray(character.bio)
      ? character.bio
          .sort(() => 0.5 - Math.random())
          .slice(0, 10)
          .join(' ')
      : character.bio || '';

    const bio = addHeader(`# About ${character.name}`, bioText);

    // System prompt
    const system = character.system ?? '';

    // Select random topic if available
    const topicString =
      character.topics && character.topics.length > 0
        ? character.topics[Math.floor(Math.random() * character.topics.length)]
        : null;

    // postCreationTemplate in core prompts.ts
    // Write a post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from the perspective of {{agentName}}. Do not add commentary or acknowledge this request, just write the post.
    // Write a post that is {{Spartan is dirty}} about {{Spartan is currently}}
    const topic = topicString || '';

    // Format topics list (reuse shuffled array to avoid re-shuffling)
    let topics = '';
    if (character.topics && character.topics.length > 0) {
      const filteredTopics = character.topics.filter((t) => t !== topicString);
      // Shuffle once, then slice
      for (let i = filteredTopics.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [filteredTopics[i], filteredTopics[j]] = [filteredTopics[j], filteredTopics[i]];
      }
      const selectedTopics = filteredTopics.slice(0, 5);
      if (selectedTopics.length > 0) {
        const topicsList = selectedTopics
          .map((t, index, array) => {
            if (index === array.length - 2) return `${t} and `;
            if (index === array.length - 1) return t;
            return `${t}, `;
          })
          .join('');
        topics = `${character.name} is also interested in ${topicsList}`;
      }
    }

    // Select random adjective if available
    const adjectiveString =
      character.adjectives && character.adjectives.length > 0
        ? character.adjectives[Math.floor(Math.random() * character.adjectives.length)]
        : '';

    const adjective = adjectiveString || '';

    // Only format the examples that will be used (optimization: avoids formatting both post AND message examples)
    let characterPostExamples = '';
    let characterMessageExamples = '';

    if (isPostFormat) {
      // Format post examples only when needed
      if (character.postExamples && character.postExamples.length > 0) {
        const shuffledPosts = [...character.postExamples];
        for (let i = shuffledPosts.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffledPosts[i], shuffledPosts[j]] = [shuffledPosts[j], shuffledPosts[i]];
        }
        const formattedPosts = shuffledPosts.slice(0, 50).join('\n');
        if (formattedPosts.replaceAll('\n', '').length > 0) {
          characterPostExamples = addHeader(
            `# Example Posts for ${character.name}`,
            formattedPosts
          );
        }
      }
    } else {
      // Format message examples only when needed
      if (character.messageExamples && character.messageExamples.length > 0) {
        const shuffledMessages = [...character.messageExamples];
        for (let i = shuffledMessages.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffledMessages[i], shuffledMessages[j]] = [shuffledMessages[j], shuffledMessages[i]];
        }
        const formattedMessages = shuffledMessages
          .slice(0, 5)
          .map((example) => {
            const exampleNames = Array.from({ length: 5 }, () =>
              Math.random().toString(36).substring(2, 8)
            );

            return example
              .map((msg) => {
                let messageString = `${msg.name}: ${msg.content.text}${
                  msg.content.action || msg.content.actions
                    ? ` (actions: ${msg.content.action || msg.content.actions?.join(', ')})`
                    : ''
                }`;
                exampleNames.forEach((name, index) => {
                  const placeholder = `{{name${index + 1}}}`;
                  messageString = messageString.replaceAll(placeholder, name);
                });
                return messageString;
              })
              .join('\n');
          })
          .join('\n\n');

        if (formattedMessages.replaceAll('\n', '').length > 0) {
          characterMessageExamples = addHeader(
            `# Example Conversations for ${character.name}`,
            formattedMessages
          );
        }
      }
    }

    // Only format the directions that will be used (optimization: avoids formatting both post AND message directions)
    let postDirections = '';
    let messageDirections = '';

    if (isPostFormat) {
      const hasPostStyle =
        (character?.style?.all?.length && character.style.all.length > 0) ||
        (character?.style?.post?.length && character.style.post.length > 0);
      if (hasPostStyle) {
        const all = character?.style?.all || [];
        const post = character?.style?.post || [];
        postDirections = addHeader(
          `# Post Directions for ${character.name}`,
          [...all, ...post].join('\n')
        );
      }
    } else {
      const hasChatStyle =
        (character?.style?.all?.length && character.style.all.length > 0) ||
        (character?.style?.chat?.length && character.style.chat.length > 0);
      if (hasChatStyle) {
        const all = character?.style?.all || [];
        const chat = character?.style?.chat || [];
        messageDirections = addHeader(
          `# Message Directions for ${character.name}`,
          [...all, ...chat].join('\n')
        );
      }
    }

    const directions = isPostFormat ? postDirections : messageDirections;
    const examples = isPostFormat ? characterPostExamples : characterMessageExamples;

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
      : '';
    const adjectiveSentence = adjectiveString ? `${character.name} is ${adjectiveString}` : '';
    // Combine all text sections
    const text = [bio, adjectiveSentence, topicSentence, topics, directions, examples, system]
      .filter(Boolean)
      .join('\n\n');

    return {
      values,
      data,
      text,
    };
  },
};
