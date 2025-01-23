import { NimError, NimErrorCode, ErrorSeverity } from "../errors/nimErrors.js";

export interface ParsedAlphafoldPrompt {
    sequences: string[];
    options?: {
        algorithm?: string;
        e_value?: number;
        iterations?: number;
        databases?: string[];
        relax_prediction?: boolean;
    };
}

const SEQUENCE_PATTERN = /\[SEQUENCE\](.*?)\[\/SEQUENCE\]/gs;
const OPTIONS_PATTERN = /\[OPTIONS\](.*?)\[\/OPTIONS\]/s;

export function parseAlphafoldPrompt(text: string): ParsedAlphafoldPrompt {
    try {
        // Extract sequences
        const sequences: string[] = [];
        const sequenceMatches = text.matchAll(SEQUENCE_PATTERN);
        for (const match of sequenceMatches) {
            if (match[1]) {
                sequences.push(match[1].trim());
            }
        }

        if (sequences.length === 0) {
            throw new NimError(
                NimErrorCode.VALIDATION_FAILED,
                "No sequences found in prompt",
                ErrorSeverity.HIGH
            );
        }

        // Extract options if present
        let options = {};
        const optionsMatch = text.match(OPTIONS_PATTERN);
        if (optionsMatch && optionsMatch[1]) {
            try {
                options = JSON.parse(optionsMatch[1].trim());
            } catch (e) {
                throw new NimError(
                    NimErrorCode.VALIDATION_FAILED,
                    "Invalid options JSON format",
                    ErrorSeverity.HIGH
                );
            }
        }

        return {
            sequences,
            options
        };
    } catch (error) {
        if (error instanceof NimError) {
            throw error;
        }
        throw new NimError(
            NimErrorCode.VALIDATION_FAILED,
            "Failed to parse AlphaFold prompt",
            ErrorSeverity.HIGH,
            { originalError: error }
        );
    }
}

export function createAlphafoldPrompt(sequences: string[], options?: object): string {
    let prompt = sequences
        .map(seq => `[SEQUENCE]${seq}[/SEQUENCE]`)
        .join("\n");

    if (options) {
        prompt += `\n[OPTIONS]${JSON.stringify(options, null, 2)}[/OPTIONS]`;
    }

    return prompt;
}