export function escapeMarkdown(text: string): string {
    // Don't escape if it's a code block
    if (text.startsWith("```") && text.endsWith("```")) {
        return text;
    }

    // Split the text by code blocks
    const parts = text.split(/(```[\s\S]*?```)/g);

    return parts
        .map((part, index) => {
            // If it's a code block (odd indices in the split result will be code blocks)
            if (index % 2 === 1) {
                return part;
            }
            // For regular text, only escape characters that need escaping in Markdown
            return (
                part
                    // First preserve any intended inline code spans
                    .replace(/`.*?`/g, (match) => match)
                    // Then only escape the minimal set of special characters that need escaping in Markdown mode
                    .replace(/([*_`\\])/g, "\\$1")
            );
        })
        .join("");
}

/**
 * Splits a message into chunks that fit within Telegram's message length limit
 */
export function splitMessage(text: string, maxLength: number = 3000): string[] {
    const chunks: string[] = [];
    let currentChunk = "";

    const lines = text.split("\n");
    for (const line of lines) {
        if (currentChunk.length + line.length + 1 <= maxLength) {
            currentChunk += (currentChunk ? "\n" : "") + line;
        } else {
            if (currentChunk) chunks.push(currentChunk);
            currentChunk = line;
        }
    }

    if (currentChunk) chunks.push(currentChunk);
    return chunks;
}
