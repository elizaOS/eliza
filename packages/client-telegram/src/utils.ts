export function cosineSimilarity(text1: string, text2: string, text3?: string): number {
    const preprocessText = (text: string) => text
        .toLowerCase()
        .replace(/[^\w\s'_-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const getWords = (text: string) => {
        return text.split(' ').filter(word => word.length > 1);
    };

    const words1 = getWords(preprocessText(text1));
    const words2 = getWords(preprocessText(text2));
    const words3 = text3 ? getWords(preprocessText(text3)) : [];

    const freq1: { [key: string]: number } = {};
    const freq2: { [key: string]: number } = {};
    const freq3: { [key: string]: number } = {};

    words1.forEach(word => freq1[word] = (freq1[word] || 0) + 1);
    words2.forEach(word => freq2[word] = (freq2[word] || 0) + 1);
    if (words3.length) {
        words3.forEach(word => freq3[word] = (freq3[word] || 0) + 1);
    }

    const uniqueWords = new Set([...Object.keys(freq1), ...Object.keys(freq2), ...(words3.length ? Object.keys(freq3) : [])]);

    let dotProduct = 0;
    let magnitude1 = 0;
    let magnitude2 = 0;
    let magnitude3 = 0;

    uniqueWords.forEach(word => {
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

    if (magnitude1 === 0 || magnitude2 === 0 || (words3.length && magnitude3 === 0)) return 0;

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

export function escapeMarkdown(text: string): string {
    // Don't escape if it's a code block
    if (text.startsWith('```') && text.endsWith('```')) {
        return text;
    }

    // Split the text by code blocks
    const parts = text.split(/(```[\s\S]*?```)/g);

    return parts.map((part, index) => {
        // If it's a code block (odd indices in the split result will be code blocks)
        if (index % 2 === 1) {
            return part;
        }
        // For regular text, only escape characters that need escaping in Markdown
        return part
            // First preserve any intended inline code spans
            .replace(/`.*?`/g, match => match)
            // Then only escape the minimal set of special characters that need escaping in Markdown mode
            .replace(/([*_`\\])/g, '\\$1');
    }).join('');
}

/**
 * Splits a message into chunks that fit within Telegram's message length limit
 */
export function splitMessage(text: string, maxLength: number = 4096): string[] {
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