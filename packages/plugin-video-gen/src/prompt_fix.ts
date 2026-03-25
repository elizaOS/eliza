export const sanitizeVideoPrompt = (prompt: string): string => {
    return prompt.length > 1000 ? prompt.substring(0, 997) + "..." : prompt;
}
