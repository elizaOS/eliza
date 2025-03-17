import {
  type IAgentRuntime,
  ModelType,
  logger,
  parseJSONObjectFromText,
  trimTokens,
} from '@elizaos/core';
import {
  ChannelType,
  type Message as DiscordMessage,
  PermissionsBitField,
  type TextChannel,
  ThreadChannel,
} from 'discord.js';

/**
 * Generates a WAV file header based on the provided audio information.
 * @param {number} audioLength - The length of the audio data in bytes.
 * @param {number} sampleRate - The sample rate of the audio.
 * @param {number} [channelCount=1] - The number of audio channels (default is 1).
 * @param {number} [bitsPerSample=16] - The number of bits per audio sample (default is 16).
 * @returns {Buffer} The generated WAV file header as a Buffer object.
 */
export function getWavHeader(
  audioLength: number,
  sampleRate: number,
  channelCount = 1,
  bitsPerSample = 16
): Buffer {
  const wavHeader = Buffer.alloc(44);
  wavHeader.write('RIFF', 0);
  wavHeader.writeUInt32LE(36 + audioLength, 4); // Length of entire file in bytes minus 8
  wavHeader.write('WAVE', 8);
  wavHeader.write('fmt ', 12);
  wavHeader.writeUInt32LE(16, 16); // Length of format data
  wavHeader.writeUInt16LE(1, 20); // Type of format (1 is PCM)
  wavHeader.writeUInt16LE(channelCount, 22); // Number of channels
  wavHeader.writeUInt32LE(sampleRate, 24); // Sample rate
  wavHeader.writeUInt32LE((sampleRate * bitsPerSample * channelCount) / 8, 28); // Byte rate
  wavHeader.writeUInt16LE((bitsPerSample * channelCount) / 8, 32); // Block align ((BitsPerSample * Channels) / 8)
  wavHeader.writeUInt16LE(bitsPerSample, 34); // Bits per sample
  wavHeader.write('data', 36); // Data chunk header
  wavHeader.writeUInt32LE(audioLength, 40); // Data chunk size
  return wavHeader;
}

const MAX_MESSAGE_LENGTH = 1900;

/**
 * Generates a summary for a given text using a specified model.
 *
 * @param {IAgentRuntime} runtime - The IAgentRuntime instance.
 * @param {string} text - The text for which to generate a summary.
 * @returns {Promise<{ title: string; description: string }>} An object containing the generated title and summary.
 */
export async function generateSummary(
  runtime: IAgentRuntime,
  text: string
): Promise<{ title: string; description: string }> {
  // make sure text is under 128k characters
  text = await trimTokens(text, 100000, runtime);

  const prompt = `Please generate a concise summary for the following text:

  Text: """
  ${text}
  """

  Respond with a JSON object in the following format:
  \`\`\`json
  {
    "title": "Generated Title",
    "summary": "Generated summary and/or description of the text"
  }
  \`\`\``;

  const response = await runtime.useModel(ModelType.TEXT_SMALL, {
    prompt,
  });

  const parsedResponse = parseJSONObjectFromText(response);

  if (parsedResponse?.title && parsedResponse?.summary) {
    return {
      title: parsedResponse.title,
      description: parsedResponse.summary,
    };
  }

  return {
    title: '',
    description: '',
  };
}

/**
 * Sends a message in chunks to a specified Discord TextChannel.
 * @param {TextChannel} channel - The Discord TextChannel to send the message to.
 * @param {string} content - The content of the message to be sent.
 * @param {string} _inReplyTo - The message ID to reply to (if applicable).
 * @param {any[]} files - Array of files to attach to the message.
 * @returns {Promise<DiscordMessage[]>} - Array of sent Discord messages.
 */
export async function sendMessageInChunks(
  channel: TextChannel,
  content: string,
  _inReplyTo: string,
  files: any[]
): Promise<DiscordMessage[]> {
  const sentMessages: DiscordMessage[] = [];
  const messages = splitMessage(content);
  try {
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (message.trim().length > 0 || (i === messages.length - 1 && files && files.length > 0)) {
        const options: any = {
          content: message.trim(),
        };

        // if (i === 0 && inReplyTo) {
        //   // Reply to the specified message for the first chunk
        //   options.reply = {
        //     messageReference: inReplyTo,
        //   };
        // }

        if (i === messages.length - 1 && files && files.length > 0) {
          // Attach files to the last message chunk
          options.files = files;
        }

        const m = await channel.send(options);
        sentMessages.push(m);
      }
    }
  } catch (error) {
    logger.error('Error sending message:', error);
  }

  return sentMessages;
}

/**
 * Splits the content into an array of strings based on the maximum message length.
 * @param {string} content - The content to split into messages
 * @returns {string[]} An array of strings that represent the split messages
 */
function splitMessage(content: string): string[] {
  const messages: string[] = [];
  let currentMessage = '';

  const rawLines = content?.split('\n') || [];
  // split all lines into MAX_MESSAGE_LENGTH chunks so any long lines are split
  const lines = rawLines.flatMap((line) => {
    const chunks = [];
    while (line.length > MAX_MESSAGE_LENGTH) {
      chunks.push(line.slice(0, MAX_MESSAGE_LENGTH));
      line = line.slice(MAX_MESSAGE_LENGTH);
    }
    chunks.push(line);
    return chunks;
  });

  for (const line of lines) {
    if (currentMessage.length + line.length + 1 > MAX_MESSAGE_LENGTH) {
      messages.push(currentMessage.trim());
      currentMessage = '';
    }
    currentMessage += `${line}\n`;
  }

  if (currentMessage.trim().length > 0) {
    messages.push(currentMessage.trim());
  }

  return messages;
}

/**
 * Checks if the bot can send messages in a given channel by checking permissions.
 * @param {TextChannel | NewsChannel | ThreadChannel} channel - The channel to check permissions for.
 * @returns {Object} Object containing information about whether the bot can send messages or not.
 * @returns {boolean} canSend - Whether the bot can send messages in the channel.
 * @returns {string} reason - The reason why the bot cannot send messages, if applicable.
 * @returns {string[]} missingPermissions - Array of missing permissions, if any.
 */
export function canSendMessage(channel) {
  // validate input
  if (!channel) {
    return {
      canSend: false,
      reason: 'No channel given',
    };
  }
  // if it is a DM channel, we can always send messages
  if (channel.type === ChannelType.DM) {
    return {
      canSend: true,
      reason: null,
    };
  }
  const botMember = channel.guild?.members.cache.get(channel.client.user.id);

  if (!botMember) {
    return {
      canSend: false,
      reason: 'Not a guild channel or bot member not found',
    };
  }

  // Required permissions for sending messages
  const requiredPermissions = [
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.ReadMessageHistory,
  ];

  // Add thread-specific permission if it's a thread
  if (channel instanceof ThreadChannel) {
    requiredPermissions.push(PermissionsBitField.Flags.SendMessagesInThreads);
  }

  // Check permissions
  const permissions = channel.permissionsFor(botMember);

  if (!permissions) {
    return {
      canSend: false,
      reason: 'Could not retrieve permissions',
    };
  }

  // Check each required permission
  const missingPermissions = requiredPermissions.filter((perm) => !permissions.has(perm));

  return {
    canSend: missingPermissions.length === 0,
    missingPermissions: missingPermissions,
    reason:
      missingPermissions.length > 0
        ? `Missing permissions: ${missingPermissions.map((p) => String(p)).join(', ')}`
        : null,
  };
}
