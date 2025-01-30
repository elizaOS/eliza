import { z } from "zod";

// Define the block types we need for structure
export const EmailBlockTypeEnum = z.enum([
    'paragraph',
    'bulletList',
    'heading',
    'callout',
    'signature',
    'banner'
]);

// Make metadata more flexible
export const EmailMetadataSchema = z.object({
    tone: z.string().describe('The overall tone of the email'),
    intent: z.string().describe('The primary purpose of the email'),
    priority: z.enum(['low', 'medium', 'high']).describe('The priority level of the email'),
    language: z.string().optional().describe('The language to use for the email')
});

export const EmailBlockSchema = z.object({
    type: EmailBlockTypeEnum,
    content: z.union([z.string(), z.array(z.string())]),
    metadata: z.object({
        style: z.string().optional(),
        className: z.string().optional(),
        importance: z.enum(['high', 'medium', 'low']).optional()
    }).optional()
});

export const EmailPromptSchema = z.object({
    content: z.string(),
    format: z.enum(['bullet', 'paragraph']).optional(),
    tone: z.string().optional(),
    language: z.string().optional(),
    style: z.string().optional()
});

export const EmailGenerationSchema = z.object({
    name: z.literal('generateEmail'),
    parameters: z.object({
        subject: z.string().min(1).max(100).describe('The email subject line'),
        blocks: z.array(EmailBlockSchema).describe('The content blocks making up the email body'),
        metadata: EmailMetadataSchema.describe('Metadata about the email')
    })
});

export const formatBlock = (block: EmailBlock): string => {
    if (typeof block.content === 'string') {
        return block.content;
    }

    switch (block.type) {
        case "paragraph":
        case "heading":
        case "callout":
        case "banner":
            return block.content.toString();
        case "bulletList":
            return block.content.map(item => `• ${item}`).join("\n");
        case "signature":
            return `\n--\n${block.content.join("\n")}`;
        default:
            return "";
    }
};

// Export types
export type EmailBlock = z.infer<typeof EmailBlockSchema>;
export type EmailMetadata = z.infer<typeof EmailMetadataSchema>;
export type EmailGeneration = z.infer<typeof EmailGenerationSchema>;
export type EmailPrompt = z.infer<typeof EmailPromptSchema>;
