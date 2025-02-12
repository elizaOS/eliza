import { z } from "zod";
import logger from "./logger";

// Helper schemas for nested types
export const MessageExampleSchema = z.object({
    user: z.string(),
    content: z
        .object({
            text: z.string(),
            action: z.string().optional(),
            source: z.string().optional(),
            url: z.string().optional(),
            inReplyTo: z.string().uuid().optional(),
            attachments: z.array(z.any()).optional(),
        })
        .and(z.record(z.string(), z.unknown())), // For additional properties
});

export const PluginSchema = z.object({
    name: z.string(),
    description: z.string(),
    actions: z.array(z.any()).optional(),
    providers: z.array(z.any()).optional(),
    evaluators: z.array(z.any()).optional(),
    services: z.array(z.any()).optional(),
    clients: z.array(z.any()).optional(),
});

// Main Character schema
export const CharacterSchema = z.object({
    id: z.string().uuid().optional(),
    name: z.string(),
    system: z.string().optional(),
    templates: z.record(z.string()).optional(),
    bio: z.union([z.string(), z.array(z.string())]),
    lore: z.array(z.string()),
    messageExamples: z.array(z.array(MessageExampleSchema)),
    postExamples: z.array(z.string()),
    topics: z.array(z.string()),
    adjectives: z.array(z.string()),
    knowledge: z
        .array(
            z.union([
                z.string(), // Direct knowledge strings
                z.object({
                    // Individual file config
                    path: z.string(),
                    shared: z.boolean().optional(),
                }),
                z.object({
                    // Directory config
                    directory: z.string(),
                    shared: z.boolean().optional(),
                }),
            ])
        )
        .optional(),
    plugins: z.union([z.array(z.string()), z.array(PluginSchema)]),
    settings: z
        .object({
            secrets: z.record(z.string()).optional(),
            voice: z
                .object({
                    model: z.string().optional(),
                    url: z.string().optional(),
                })
                .optional(),
            model: z.string().optional(),
            modelConfig: z.object({
                maxInputTokens: z.number().optional(),
                maxOutputTokens: z.number().optional(),
                temperature: z.number().optional(),
                frequency_penalty: z.number().optional(),
                presence_penalty:z.number().optional()
            })
            .optional(),
            embeddingModel: z.string().optional(),
        })
        .optional(),
    style: z.object({
        all: z.array(z.string()),
        chat: z.array(z.string()),
        post: z.array(z.string()),
    }),
    extends: z.array(z.string()).optional(),
});

// Type inference
export type CharacterConfig = z.infer<typeof CharacterSchema>;

// Validation function
export function validateCharacterConfig(json: unknown): CharacterConfig {
    try {
        return CharacterSchema.parse(json);
    } catch (error) {
        if (error instanceof z.ZodError) {
            const groupedErrors = error.errors.reduce(
                (acc, err) => {
                    const path = err.path.join(".");
                    if (!acc[path]) {
                        acc[path] = [];
                    }
                    acc[path].push(err.message);
                    return acc;
                },
                {} as Record<string, string[]>
            );

            for (const field in groupedErrors) {
                logger.error(
                    `Validation errors in ${field}: ${groupedErrors[field].join(" - ")}`
                );
            }

            throw new Error(
                "Character configuration validation failed. Check logs for details."
            );
        }
        throw error;
    }
}
