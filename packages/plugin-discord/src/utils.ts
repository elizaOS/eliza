import {
    type IAgentRuntime,
    ModelClass,
    logger,
    generateText,
    trimTokens,
    parseJSONObjectFromText,
} from "@elizaos/core";
import {
    ChannelType,
    type Message as DiscordMessage,
    PermissionsBitField,
    type TextChannel,
    ThreadChannel,
} from "discord.js";

export function getWavHeader(
    audioLength: number,
    sampleRate: number,
    channelCount = 1,
    bitsPerSample = 16
): Buffer {
    const wavHeader = Buffer.alloc(44);
    wavHeader.write("RIFF", 0);
    wavHeader.writeUInt32LE(36 + audioLength, 4); // Length of entire file in bytes minus 8
    wavHeader.write("WAVE", 8);
    wavHeader.write("fmt ", 12);
    wavHeader.writeUInt32LE(16, 16); // Length of format data
    wavHeader.writeUInt16LE(1, 20); // Type of format (1 is PCM)
    wavHeader.writeUInt16LE(channelCount, 22); // Number of channels
    wavHeader.writeUInt32LE(sampleRate, 24); // Sample rate
    wavHeader.writeUInt32LE(
        (sampleRate * bitsPerSample * channelCount) / 8,
        28
    ); // Byte rate
    wavHeader.writeUInt16LE((bitsPerSample * channelCount) / 8, 32); // Block align ((BitsPerSample * Channels) / 8)
    wavHeader.writeUInt16LE(bitsPerSample, 34); // Bits per sample
    wavHeader.write("data", 36); // Data chunk header
    wavHeader.writeUInt32LE(audioLength, 40); // Data chunk size
    return wavHeader;
}

const MAX_MESSAGE_LENGTH = 1900;

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

    const response = await generateText({
        runtime,
        context: prompt,
        modelClass: ModelClass.TEXT_SMALL,
    });

    const parsedResponse = parseJSONObjectFromText(response);

    if (parsedResponse?.title && parsedResponse?.summary) {
        return {
            title: parsedResponse.title,
            description: parsedResponse.summary,
        };
    }

    return {
        title: "",
        description: "",
    };
}

export async function sendMessageInChunks(
    channel: TextChannel,
    content: string,
    inReplyTo: string,
    files: any[]
): Promise<DiscordMessage[]> {
    const sentMessages: DiscordMessage[] = [];
    const messages = splitMessage(content);
    try {
        for (let i = 0; i < messages.length; i++) {
            const message = messages[i];
            if (
                message.trim().length > 0 ||
                (i === messages.length - 1 && files && files.length > 0)
            ) {
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
        logger.error("Error sending message:", error);
    }

    return sentMessages;
}

function splitMessage(content: string): string[] {
    const messages: string[] = [];
    let currentMessage = "";

    const rawLines = content?.split("\n") || [];
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
            currentMessage = "";
        }
        currentMessage += line + "\n";
    }

    if (currentMessage.trim().length > 0) {
        messages.push(currentMessage.trim());
    }

    return messages;
}

export function canSendMessage(channel) {
    // validate input
    if (!channel) {
        return {
            canSend: false,
            reason: "No channel given",
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
            reason: "Not a guild channel or bot member not found",
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
        requiredPermissions.push(
            PermissionsBitField.Flags.SendMessagesInThreads
        );
    }

    // Check permissions
    const permissions = channel.permissionsFor(botMember);

    if (!permissions) {
        return {
            canSend: false,
            reason: "Could not retrieve permissions",
        };
    }

    // Check each required permission
    const missingPermissions = requiredPermissions.filter(
        (perm) => !permissions.has(perm)
    );

    return {
        canSend: missingPermissions.length === 0,
        missingPermissions: missingPermissions,
        reason:
            missingPermissions.length > 0
                ? `Missing permissions: ${missingPermissions
                      .map((p) => String(p))
                      .join(", ")}`
                : null,
    };
}
