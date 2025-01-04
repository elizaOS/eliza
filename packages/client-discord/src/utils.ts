import {
    IAgentRuntime,
    ModelClass,
    elizaLogger,
    generateText,
    trimTokens,
    parseJSONObjectFromText,
} from "@elizaos/core";
import {
    ChannelType,
    Message as DiscordMessage,
    PermissionsBitField,
    TextChannel,
    ThreadChannel,
} from "discord.js";

export function getWavHeader(
    audioLength: number,
    sampleRate: number,
    channelCount: number = 1,
    bitsPerSample: number = 16
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
        modelClass: ModelClass.SMALL,
    });

    const parsedResponse = parseJSONObjectFromText(response);

    if (parsedResponse) {
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
        elizaLogger.error("Error sending message:", error);
    }

    return sentMessages;
}

function splitMessage(content: string): string[] {
    const messages: string[] = [];
    let currentMessage = "";

    const rawLines = content?.split("\n") || [];
    // split all lines into MAX_MESSAGE_LENGTH chunks so any long lines are split
    const lines = rawLines
        .map((line) => {
            const chunks = [];
            while (line.length > MAX_MESSAGE_LENGTH) {
                chunks.push(line.slice(0, MAX_MESSAGE_LENGTH));
                line = line.slice(MAX_MESSAGE_LENGTH);
            }
            chunks.push(line);
            return chunks;
        })
        .flat();

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
                ? `Missing permissions: ${missingPermissions.map((p) => String(p)).join(", ")}`
                : null,
    };
}

export function cosineSimilarity(
    text1: string,
    text2: string,
    text3?: string
): number {
    const preprocessText = (text: string) =>
        text
            .toLowerCase()
            .replace(/[^\w\s'_-]/g, " ")
            .replace(/\s+/g, " ")
            .trim();

    const getWords = (text: string) => {
        return text.split(" ").filter((word) => word.length > 1);
    };

    const words1 = getWords(preprocessText(text1));
    const words2 = getWords(preprocessText(text2));
    const words3 = text3 ? getWords(preprocessText(text3)) : [];

    const freq1: { [key: string]: number } = {};
    const freq2: { [key: string]: number } = {};
    const freq3: { [key: string]: number } = {};

    words1.forEach((word) => (freq1[word] = (freq1[word] || 0) + 1));
    words2.forEach((word) => (freq2[word] = (freq2[word] || 0) + 1));
    if (words3.length) {
        words3.forEach((word) => (freq3[word] = (freq3[word] || 0) + 1));
    }

    const uniqueWords = new Set([
        ...Object.keys(freq1),
        ...Object.keys(freq2),
        ...(words3.length ? Object.keys(freq3) : []),
    ]);

    let dotProduct = 0;
    let magnitude1 = 0;
    let magnitude2 = 0;
    let magnitude3 = 0;

    uniqueWords.forEach((word) => {
        const val1 = freq1[word] || 0;
        const val2 = freq2[word] || 0;
        const val3 = freq3[word] || 0;

        if (words3.length) {
            // For three-way, calculate pairwise similarities
            const sim12 = val1 * val2;
            const sim23 = val2 * val3;
            const sim13 = val1 * val3;

            // Take maximum similarity between any pair
            dotProduct += Math.max(sim12, sim23, sim13);
        } else {
            dotProduct += val1 * val2;
        }

        magnitude1 += val1 * val1;
        magnitude2 += val2 * val2;
        if (words3.length) {
            magnitude3 += val3 * val3;
        }
    });

    magnitude1 = Math.sqrt(magnitude1);
    magnitude2 = Math.sqrt(magnitude2);
    magnitude3 = words3.length ? Math.sqrt(magnitude3) : 1;

    if (
        magnitude1 === 0 ||
        magnitude2 === 0 ||
        (words3.length && magnitude3 === 0)
    )
        return 0;

    // For two texts, use original calculation
    if (!words3.length) {
        return dotProduct / (magnitude1 * magnitude2);
    }

    // For three texts, use max magnitude pair to maintain scale
    const maxMagnitude = Math.max(
        magnitude1 * magnitude2,
        magnitude2 * magnitude3,
        magnitude1 * magnitude3
    );

    return dotProduct / maxMagnitude;
}
