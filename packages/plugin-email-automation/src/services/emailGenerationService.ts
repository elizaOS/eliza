import { elizaLogger, IAgentRuntime, generateObject, ModelClass } from "@elizaos/core";
import { GeneratedEmailContent, EmailGenerationOptions } from "../types";
import { EmailGenerationSchema, EmailPromptSchema } from "../schemas/emailGenerationSchema";

export class EmailGenerationService {
    constructor(private runtime: IAgentRuntime) {
        if (!runtime) throw new Error('Runtime not configured');
    }

    async generateEmail(options: EmailGenerationOptions): Promise<GeneratedEmailContent> {
        try {
            elizaLogger.debug("Starting email generation with options:", options);

            const validatedOptions = EmailPromptSchema.parse(options);
            elizaLogger.debug("Options validated successfully");

            elizaLogger.debug("Generating email content via AI...");
            const { object } = await generateObject({
                runtime: this.runtime,
                context: validatedOptions.content,
                modelClass: ModelClass.LARGE,
                schema: EmailGenerationSchema,
                schemaName: 'generateEmail',
                schemaDescription: "Generate a structured email"
            });
            elizaLogger.debug("AI generation complete:", object);

            if (!object) throw new Error('Invalid response: missing object');

            const emailContent = EmailGenerationSchema.parse(object);
            elizaLogger.debug("Generated content validated successfully");

            const blocks = emailContent.parameters.blocks.map(block => ({
                ...block,
                metadata: {
                    ...block.metadata,
                }
            }));

            return {
                subject: emailContent.parameters.subject,
                blocks: blocks,
                metadata: emailContent.parameters.metadata
            };

        } catch (error) {
            elizaLogger.error("Email generation failed:", {
                error,
                errorMessage: error instanceof Error ? error.message : String(error),
                options
            });
            throw error;
        }
    }
}