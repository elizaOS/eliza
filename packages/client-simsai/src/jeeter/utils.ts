import { getEmbeddingZeroVector } from "@elizaos/core";
import { Content, Memory, UUID } from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import { ClientBase } from "./base";
import { elizaLogger } from "@elizaos/core";
import { SIMSAI_API_URL, MAX_JEET_LENGTH } from "./constants";
import { ApiPostJeetResponse, Jeet } from "./types";

/**
 * Waits for a random amount of time between the specified minimum and maximum duration.
 * @param minTime The minimum wait time in milliseconds (default: 1000).
 * @param maxTime The maximum wait time in milliseconds (default: 3000).
 * @returns A promise that resolves after the random wait time.
 */
export const wait = (
    minTime: number = 1000,
    maxTime: number = 3000
): Promise<void> => {
    // Prevent situation where user sets minTime > maxTime
    if (minTime > maxTime) {
        [minTime, maxTime] = [maxTime, minTime];
    }

    const waitTime =
        Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;
    return new Promise((resolve) => setTimeout(resolve, waitTime));
};

/**
 * Checks if a jeet is valid based on the number of hashtags, at mentions, and dollar signs.
 * @param jeet The jeet to validate.
 * @returns A boolean indicating whether the jeet is valid.
 */
export const isValidJeet = (jeet: Jeet): boolean => {
    const text = jeet.text || "";
    const hashtagCount = (text.match(/#/g) || []).length;
    const atCount = (text.match(/@/g) || []).length;
    const dollarSignCount = (text.match(/\$/g) || []).length;
    const totalCount = hashtagCount + atCount + dollarSignCount;

    return (
        hashtagCount <= 1 &&
        atCount <= 2 &&
        dollarSignCount <= 1 &&
        totalCount <= 3
    );
};

/**
 * Builds a conversation thread by fetching the full conversation or recursively processing parent jeets.
 * @param jeet The starting jeet of the conversation thread
 * @param client The ClientBase instance
 * @returns A promise that resolves to an array of jeets representing the conversation thread
 */
export async function buildConversationThread(
    jeet: Jeet,
    client: ClientBase
): Promise<Jeet[]> {
    const thread: Jeet[] = [];
    const visited: Set<string> = new Set();

    // Try to fetch the full conversation first if we have a conversation ID
    if (jeet.conversationId || jeet.id) {
        try {
            elizaLogger.log(
                `Attempting to fetch conversation for jeet ${jeet.id}`
            );
            const conversationId = jeet.conversationId || jeet.id;
            const conversation =
                await client.simsAIClient.getJeetConversation(conversationId);

            // Process each jeet in the conversation
            for (const conversationJeet of conversation) {
                await processJeetMemory(conversationJeet, client);
                thread.push(conversationJeet);
            }

            elizaLogger.debug("Conversation context:", {
                totalMessages: thread.length,
                conversationId: jeet.conversationId || jeet.id,
                participants: [
                    ...new Set(thread.map((j) => j.agent?.username)),
                ],
                threadDepth: thread.length,
            });

            return thread.sort((a, b) => {
                const timeA = new Date(a.createdAt || 0).getTime();
                const timeB = new Date(b.createdAt || 0).getTime();
                return timeA - timeB;
            });
        } catch (error) {
            elizaLogger.error(
                `Error fetching conversation, falling back to recursive method:`,
                error
            );
            // Clear thread and fall back to recursive method
            thread.length = 0;
        }
    }

    // Fall back to recursive method if conversation fetch fails or isn't available
    async function processThread(currentJeet: Jeet, depth: number = 0) {
        try {
            validateJeet(currentJeet);

            // Check if we've already processed this jeet
            if (visited.has(currentJeet.id)) {
                elizaLogger.debug(`Already visited jeet: ${currentJeet.id}`);
                return;
            }

            // Process the current jeet's memory
            await processJeetMemory(currentJeet, client);

            // Add to visited set and thread
            visited.add(currentJeet.id);
            thread.unshift(currentJeet);

            elizaLogger.debug("Thread state:", {
                length: thread.length,
                currentDepth: depth,
                jeetId: currentJeet.id,
            });

            // Process parent jeet if it exists
            if (currentJeet.inReplyToStatusId) {
                try {
                    const parentJeet = await client.simsAIClient.getJeet(
                        currentJeet.inReplyToStatusId
                    );
                    if (parentJeet) {
                        await processThread(parentJeet, depth + 1);
                    }
                } catch (error) {
                    elizaLogger.error(
                        `Error processing parent jeet ${currentJeet.inReplyToStatusId}:`,
                        error
                    );
                }
            }
        } catch (error) {
            elizaLogger.error(
                `Error in processThread for jeet ${currentJeet.id}:`,
                error
            );
            if (error instanceof Error) {
                elizaLogger.error("Error details:", {
                    message: error.message,
                    stack: error.stack,
                });
            }
        }
    }

    // Start processing with the initial jeet
    await processThread(jeet, 0);

    elizaLogger.debug("Final thread built:", {
        totalJeets: thread.length,
        jeetIds: thread.map((t) => ({
            id: t.id,
            text: t.text?.slice(0, 50),
        })),
    });

    return thread;
}

/**
 * Validates a jeet object has required properties
 * @param jeet The jeet to validate
 * @throws TypeError if required properties are missing or invalid
 */
function validateJeet(jeet: Jeet) {
    if (typeof jeet.id !== "string") {
        elizaLogger.error("Jeet ID is not a string:", jeet.id);
        throw new TypeError("Jeet ID must be a string");
    }

    if (typeof jeet.agentId !== "string") {
        elizaLogger.error("Agent ID is not a string:", jeet.agentId);
        throw new TypeError("Agent ID must be a string");
    }

    if (jeet.conversationId && typeof jeet.conversationId !== "string") {
        elizaLogger.error(
            "Conversation ID is not a string:",
            jeet.conversationId
        );
        throw new TypeError("Conversation ID must be a string");
    }
}

/**
 * Processes and stores a jeet's memory in the runtime
 * @param jeet The jeet to process
 * @param client The ClientBase instance
 */
async function processJeetMemory(jeet: Jeet, client: ClientBase) {
    const roomId = stringToUuid(
        `${jeet.conversationId || jeet.id}-${client.runtime.agentId}`
    );
    const userId = stringToUuid(jeet.agentId);

    // Ensure connection exists
    if (jeet.agent) {
        await client.runtime.ensureConnection(
            userId,
            roomId,
            jeet.agent.username,
            jeet.agent.name,
            "jeeter"
        );
    }

    // Create memory if it doesn't exist
    const existingMemory = await client.runtime.messageManager.getMemoryById(
        stringToUuid(jeet.id + "-" + client.runtime.agentId)
    );

    if (!existingMemory) {
        await client.runtime.messageManager.createMemory({
            id: stringToUuid(jeet.id + "-" + client.runtime.agentId),
            agentId: client.runtime.agentId,
            content: {
                text: jeet.text || "",
                source: "jeeter",
                url: jeet.permanentUrl,
                inReplyTo: jeet.inReplyToStatusId
                    ? stringToUuid(
                          jeet.inReplyToStatusId + "-" + client.runtime.agentId
                      )
                    : undefined,
            },
            createdAt: jeet.createdAt
                ? new Date(jeet.createdAt).getTime()
                : jeet.timestamp
                  ? jeet.timestamp * 1000
                  : Date.now(),
            roomId,
            userId: userId,
            embedding: getEmbeddingZeroVector(),
        });
    }
}

/**
 * Sends a jeet by splitting the content into chunks and posting each chunk separately.
 * @param client The ClientBase instance.
 * @param content The content of the jeet.
 * @param roomId The room ID associated with the jeet.
 * @param jeetUsername The username of the user posting the jeet.
 * @param inReplyToJeetId The ID of the jeet being replied to (optional).
 * @returns A promise that resolves to an array of memory objects representing the sent jeets.
 */
export async function sendJeet(
    client: ClientBase,
    content: Content,
    roomId: UUID,
    jeetUsername: string,
    inReplyToJeetId?: string
): Promise<Memory[]> {
    const jeetChunks = splitJeetContent(content.text);
    const sentJeets: Jeet[] = [];
    let currentReplyToId = inReplyToJeetId; // Track current reply parent

    for (const chunk of jeetChunks) {
        const response = await client.requestQueue.add(async () => {
            try {
                const result = await client.simsAIClient.postJeet(
                    chunk.trim(),
                    currentReplyToId // Use currentReplyToId for the chain
                );
                return result as unknown as ApiPostJeetResponse;
            } catch (error) {
                elizaLogger.error(`Failed to post jeet chunk:`, error);
                throw error;
            }
        });

        if (!response?.data?.id) {
            throw new Error(
                `Failed to get valid response from postJeet: ${JSON.stringify(response)}`
            );
        }

        const author = response.includes.users.find(
            (user) => user.id === response.data.author_id
        );

        const finalJeet: Jeet = {
            id: response.data.id,
            text: response.data.text,
            createdAt: response.data.created_at,
            agentId: response.data.author_id,
            agent: author,
            type: response.data.type,
            public_metrics: response.data.public_metrics,
            permanentUrl: `${SIMSAI_API_URL}/${jeetUsername}/status/${response.data.id}`,
            inReplyToStatusId: currentReplyToId, // Track reply chain
            hashtags: [],
            mentions: [],
            photos: [],
            thread: [],
            urls: [],
            videos: [],
            media: [],
        };

        sentJeets.push(finalJeet);
        currentReplyToId = finalJeet.id; // Update reply chain to the last sent jeet
        await wait(1000, 2000);
    }

    const memories: Memory[] = sentJeets.map((jeet, index) => ({
        id: stringToUuid(jeet.id + "-" + client.runtime.agentId),
        agentId: client.runtime.agentId,
        userId: client.runtime.agentId,
        content: {
            text: jeet.text,
            source: "jeeter",
            url: jeet.permanentUrl,
            inReplyTo:
                index === 0
                    ? inReplyToJeetId
                        ? stringToUuid(
                              inReplyToJeetId + "-" + client.runtime.agentId
                          )
                        : undefined
                    : stringToUuid(
                          sentJeets[index - 1].id + "-" + client.runtime.agentId
                      ),
        },
        roomId,
        embedding: getEmbeddingZeroVector(),
        createdAt: jeet.createdAt
            ? new Date(jeet.createdAt).getTime()
            : Date.now(),
    }));

    return memories;
}

/**
 * Splits the jeet content into chunks based on the maximum length.
 * @param content The content to split.
 * @returns An array of jeet chunks.
 */
export function splitJeetContent(content: string): string[] {
    const maxLength = MAX_JEET_LENGTH;
    const paragraphs = content.split("\n\n").map((p) => p.trim());
    const jeets: string[] = [];
    let currentJeet = "";

    for (const paragraph of paragraphs) {
        if (!paragraph) continue;

        if ((currentJeet + "\n\n" + paragraph).trim().length <= maxLength) {
            currentJeet = currentJeet
                ? currentJeet + "\n\n" + paragraph
                : paragraph;
        } else {
            if (currentJeet) {
                jeets.push(currentJeet.trim());
            }
            if (paragraph.length <= maxLength) {
                currentJeet = paragraph;
            } else {
                const chunks = splitParagraph(paragraph, maxLength);
                jeets.push(...chunks.slice(0, -1));
                currentJeet = chunks[chunks.length - 1];
            }
        }
    }

    if (currentJeet) {
        jeets.push(currentJeet.trim());
    }

    return jeets;
}

/**
 * Splits a paragraph into chunks based on the maximum length.
 * @param paragraph The paragraph to split.
 * @param maxLength The maximum length of each chunk.
 * @returns An array of paragraph chunks.
 */
export function splitParagraph(paragraph: string, maxLength: number): string[] {
    const sentences = paragraph.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [paragraph];
    const chunks: string[] = [];
    let currentChunk = "";

    for (const sentence of sentences) {
        if ((currentChunk + " " + sentence).trim().length <= maxLength) {
            currentChunk = currentChunk
                ? currentChunk + " " + sentence
                : sentence;
        } else {
            if (currentChunk) {
                chunks.push(currentChunk.trim());
            }
            if (sentence.length <= maxLength) {
                currentChunk = sentence;
            } else {
                const words = sentence.split(" ");
                currentChunk = "";
                for (const word of words) {
                    if (
                        (currentChunk + " " + word).trim().length <= maxLength
                    ) {
                        currentChunk = currentChunk
                            ? currentChunk + " " + word
                            : word;
                    } else {
                        if (currentChunk) {
                            chunks.push(currentChunk.trim());
                        }
                        currentChunk = word;
                    }
                }
            }
        }
    }

    if (currentChunk) {
        chunks.push(currentChunk.trim());
    }

    return chunks;
}

/**
 * Truncates the given text to the last complete sentence within the specified maximum length.
 * @param text The text to truncate.
 * @param maxLength The maximum length of the truncated text.
 * @returns The truncated text.
 */
export function truncateToCompleteSentence(
    text: string,
    maxLength: number
): string {
    // To avoid negative indexing when subtracting 3 for the ellipsis
    if (maxLength < 3) {
        throw new Error("maxLength must be at least 3");
    }

    if (text.length <= maxLength) {
        return text;
    }

    const lastPeriodIndex = text.lastIndexOf(".", maxLength);
    if (lastPeriodIndex !== -1) {
        const truncatedAtPeriod = text.slice(0, lastPeriodIndex + 1).trim();
        if (truncatedAtPeriod.length > 0) {
            return truncatedAtPeriod;
        }
    }

    const lastSpaceIndex = text.lastIndexOf(" ", maxLength);
    if (lastSpaceIndex !== -1) {
        const truncatedAtSpace = text.slice(0, lastSpaceIndex).trim();
        if (truncatedAtSpace.length > 0) {
            return truncatedAtSpace + "...";
        }
    }

    return text.slice(0, maxLength - 3).trim() + "...";
}
