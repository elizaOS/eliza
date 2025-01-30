import { stringToUuid } from "@elizaos/core";

export const MAX_CAST_LENGTH = 1024; // Updated to Twitter's current character limit

export function castId({ hash, agentId }: { hash: string; agentId: string }) {
    return `${hash}-${agentId}`;
}

export function castUuid(props: { hash: string; agentId: string }) {
    return stringToUuid(castId(props));
}

export function splitPostContent(
    content: string,
    maxLength: number = MAX_CAST_LENGTH
): string[] {
    const paragraphs = content.split("\n\n").map((p) => p.trim());
    const posts: string[] = [];
    let currentTweet = "";

    for (const paragraph of paragraphs) {
        if (!paragraph) continue;

        if ((currentTweet + "\n\n" + paragraph).trim().length <= maxLength) {
            if (currentTweet) {
                currentTweet += "\n\n" + paragraph;
            } else {
                currentTweet = paragraph;
            }
        } else {
            if (currentTweet) {
                posts.push(currentTweet.trim());
            }
            if (paragraph.length <= maxLength) {
                currentTweet = paragraph;
            } else {
                // Split long paragraph into smaller chunks
                const chunks = splitParagraph(paragraph, maxLength);
                posts.push(...chunks.slice(0, -1));
                currentTweet = chunks[chunks.length - 1];
            }
        }
    }

    if (currentTweet) {
        posts.push(currentTweet.trim());
    }

    return posts;
}

export function splitParagraph(paragraph: string, maxLength: number): string[] {
    const sentences = paragraph.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [
        paragraph,
    ];
    const chunks: string[] = [];
    let currentChunk = "";

    for (const sentence of sentences) {
        if ((currentChunk + " " + sentence).trim().length <= maxLength) {
            if (currentChunk) {
                currentChunk += " " + sentence;
            } else {
                currentChunk = sentence;
            }
        } else {
            if (currentChunk) {
                chunks.push(currentChunk.trim());
            }
            if (sentence.length <= maxLength) {
                currentChunk = sentence;
            } else {
                // Split long sentence into smaller pieces
                const words = sentence.split(" ");
                currentChunk = "";
                for (const word of words) {
                    if (
                        (currentChunk + " " + word).trim().length <= maxLength
                    ) {
                        if (currentChunk) {
                            currentChunk += " " + word;
                        } else {
                            currentChunk = word;
                        }
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

export function populateMentions(
    text: string,
    userIds: number[],
    positions: number[],
    userMap: Record<number, string>
) {
    // Validate input arrays have same length
    if (userIds.length !== positions.length) {
        throw new Error(
            "User IDs and positions arrays must have the same length"
        );
    }

    // Create array of mention objects with position and user info
    const mentions = userIds
        .map((userId, index) => ({
            position: positions[index],
            userId,
            displayName: userMap[userId]!,
        }))
        .sort((a, b) => b.position - a.position); // Sort in reverse order to prevent position shifting

    // Create the resulting string by inserting mentions
    let result = text;
    mentions.forEach((mention) => {
        const mentionText = `@${mention.displayName}`;
        result =
            result.slice(0, mention.position) +
            mentionText +
            result.slice(mention.position);
    });

    return result;
}
