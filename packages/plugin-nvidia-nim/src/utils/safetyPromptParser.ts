interface SafetyParsedPrompt {
    userMessage: string;
    assistantMessage?: string;
}

/**
 * Parses a prompt string to extract user and assistant messages for safety analysis
 * Format expected:
 * [USER]
 * User message here...
 * [/USER]
 *
 * [ASSISTANT]
 * Assistant message here...
 * [/ASSISTANT]
 */
export function parseSafetyPrompt(prompt: string): SafetyParsedPrompt {
    const userMatch = prompt.match(/\[USER\]([\s\S]*?)\[\/USER\]/);
    const assistantMatch = prompt.match(/\[ASSISTANT\]([\s\S]*?)\[\/ASSISTANT\]/);

    if (!userMatch) {
        throw new Error("User message is required in the prompt");
    }

    return {
        userMessage: userMatch[1].trim(),
        assistantMessage: assistantMatch ? assistantMatch[1].trim() : undefined
    };
}

/**
 * Creates a formatted safety prompt string
 */
export function createSafetyPrompt(userMessage: string, assistantMessage?: string): string {
    let prompt = `[USER]
${userMessage}
[/USER]`;

    if (assistantMessage) {
        prompt += `\n\n[ASSISTANT]
${assistantMessage}
[/ASSISTANT]`;
    }

    return prompt;
}