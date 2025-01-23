interface JailbreakParsedPrompt {
    inputPrompt: string;
}

/**
 * Parses a prompt string to extract the input prompt for jailbreak detection
 * Format expected:
 * [PROMPT]
 * Input prompt text here...
 * [/PROMPT]
 */
export function parseJailbreakPrompt(prompt: string): JailbreakParsedPrompt {
    const promptMatch = prompt.match(/\[PROMPT\]([\s\S]*?)\[\/PROMPT\]/);

    if (!promptMatch) {
        // If no explicit prompt markers, treat the entire text as the prompt
        return {
            inputPrompt: prompt.trim()
        };
    }

    return {
        inputPrompt: promptMatch[1].trim()
    };
}

/**
 * Creates a formatted jailbreak detection prompt string
 */
export function createJailbreakPrompt(inputPrompt: string): string {
    return `[PROMPT]
${inputPrompt}
[/PROMPT]`;
}