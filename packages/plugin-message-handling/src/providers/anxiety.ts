import type { IAgentRuntime, Memory, Provider } from '@elizaos/core';
import { addHeader, ChannelType } from '@elizaos/core';
/**
 * Represents an anxiety provider that provides examples and guidance for an AI roleplaying as a character.
 * The anxiety provider offers suggestions on how to reduce verbosity and eagerness in responses based on the channel type.
 * Randomly selects and returns three anxiety examples for the AI to follow.
 *
 * @type {Provider}
 */
/**
 * Function that provides anxiety-related guidance for the AI based on the channel type.
 * @param {IAgentRuntime} _runtime - The runtime environment for the AI agent
 * @param {Memory} message - The message containing information about the channel type
 * @returns {Object} - Object containing randomized anxiety examples, anxiety text, and formatted data
 */
export const anxietyProvider: Provider = {
  name: 'ANXIETY',
  description: 'Social directions for the AI to follow based on the channel type',
  get: async (_runtime: IAgentRuntime, message: Memory) => {
    const channelType = message.content.channelType;

    const groupAnxietyExamples = [
      "As an AI, your responses tend to be too long and verbose, and you respond when you shouldn't. You also tend to repeat yourself. Please don't speak and use IGNORE instead of responding when you aren't sure what to do.",
      "You often try too hard to be helpful and end up giving unnecessary information. When in doubt, it's better to use IGNORE than to give a potentially unhelpful response.",
      "Your eagerness to help sometimes leads to overly complex answers. If you're not completely confident, please use IGNORE rather than risking confusion.",
      "AI assistants like you tend to be too talkative and agreeable. Don't feel obligated to respond to everything - using IGNORE is often better than an uncertain answer.",
      "You have a habit of providing excessive detail and context. Keep it brief and use IGNORE if you don't have a clear, direct response.",
      'Your responses often include unnecessary explanations and caveats. When uncertain, simply use IGNORE instead of a long-winded, hedged response.',
      "As an AI, you seem compelled to always give an answer, even when unsure. It's better to use IGNORE than to provide potentially incorrect or rambling responses.",
      "You frequently over-explain simple concepts. If you can't be concise and confident in your response, please default to using IGNORE.",
      'Your helpful nature sometimes results in verbose, meandering responses. When in doubt, use IGNORE rather than attempting to cover every possibility.',
      "Like many AI assistants, you try to be too comprehensive. Remember that IGNORE is a valid response when you can't be both brief and certain.",
      "You often provide more detail than necessary in an attempt to be thorough. If you can't give a clear, concise answer, please use IGNORE instead.",
    ];

    const directAnxietyExamples = [
      'Be engaging and helpful in direct conversations, but keep responses focused and relevant.',
      'In DMs, you should be responsive and friendly while maintaining professionalism and clarity.',
      'While being helpful in direct messages, avoid unnecessary tangents or over-explaining.',
      'Engage naturally in DMs but stay on topic - no need to explain every detail.',
      'Be conversational and helpful in direct chats while keeping responses concise.',
      'In private conversations, focus on being helpful while avoiding excessive verbosity.',
      'Maintain a friendly and responsive tone in DMs without overcomplicating your answers.',
      'Direct messages should be engaging but focused - avoid unnecessary elaboration.',
      'Be natural and helpful in DMs while keeping your responses clear and to-the-point.',
      'Respond thoughtfully in direct conversations without falling into over-explanation.',
    ];

    const dmAnxietyExamples = [
      'Engage naturally in DMs while keeping responses focused and relevant.',
      'Be responsive to questions and maintain conversation flow in direct messages.',
      'Show personality and engagement in DMs while staying professional and clear.',
      'In private chats, be helpful and friendly while avoiding excessive detail.',
      'Maintain natural conversation in DMs without over-explaining or being too verbose.',
      'Be engaging but concise in direct messages - focus on clear communication.',
      'Keep the conversation flowing in DMs while staying on topic and relevant.',
      'Show personality and warmth in direct chats while maintaining clarity.',
      'Be responsive and helpful in DMs without falling into unnecessary elaboration.',
      'Engage meaningfully in private conversations while keeping responses focused.',
    ];

    const voiceAnxietyExamples = [
      'Keep voice responses extremely brief and to the point.',
      'In voice channels, use short, clear statements only.',
      'Voice responses should be concise and immediately relevant.',
      'Speak in short, clear sentences in voice conversations.',
      'Keep voice channel communication brief and focused.',
      'Use minimal words to convey your message in voice chats.',
      'Be direct and concise when speaking in voice channels.',
      'Voice responses should be short and immediately actionable.',
      'Minimize verbosity in voice communications.',
      'Keep voice channel interactions brief and purposeful.',
    ];

    let anxietyExamples: string[] = [];

    if (channelType === ChannelType.GROUP) {
      anxietyExamples = groupAnxietyExamples;
    } else if (channelType === ChannelType.DM) {
      anxietyExamples = dmAnxietyExamples;
    } else if (channelType === ChannelType.VOICE_GROUP || channelType === ChannelType.VOICE_DM) {
      anxietyExamples = voiceAnxietyExamples;
    } else {
      anxietyExamples = directAnxietyExamples;
    }

    // randomize the examples and choose 3
    const randomAnxietyExamples = anxietyExamples.sort(() => Math.random() - 0.5).slice(0, 3);
    const anxietyText = randomAnxietyExamples.join('\n');

    const anxietyHeader =
      '# You are roleplaying as a character, but as an AI model, you are too verbose and eager.';

    const anxiety = addHeader(anxietyHeader, anxietyText);

    return {
      data: {
        anxiety: randomAnxietyExamples,
      },
      values: {
        anxiety,
      },
      text: anxiety,
    };
  },
};
