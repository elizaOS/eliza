import { elizaLogger } from "@elizaos/core";
import { EmailTemplateManager } from "./emailTemplateManager";
import { ResendProvider } from "../providers/resend";
import {
    EmailOptions,
    EmailServiceOptions,
    EmailProviderResponse,
    GeneratedEmailContent,
    EmailTemplate
} from "../types";

export class EmailService {
    private templateManager: EmailTemplateManager;
    private provider: ResendProvider;

    constructor(
        private secrets: EmailServiceOptions,
        templateManager?: EmailTemplateManager
    ) {
        elizaLogger.debug("Initializing EmailService");
        this.templateManager = templateManager || new EmailTemplateManager();
        this.provider = new ResendProvider(this.secrets.RESEND_API_KEY);
    }

    async sendEmail(
        content: GeneratedEmailContent,
        options: Omit<EmailOptions, 'subject' | 'body' | 'html'>
    ): Promise<EmailProviderResponse> {
        elizaLogger.info("Starting email send process", {
            hasContent: !!content,
            contentType: content ? typeof content : 'undefined',
            templateManager: !!this.templateManager,
            blocks: content.blocks
        });

        try {
            const html = await this.templateManager.renderEmail(content);
            const plainText = this.generatePlainText(content);

            elizaLogger.debug("Template rendered", {
                hasHtml: !!html,
                template: options.template || 'default',
                htmlLength: html?.length || 0,
                htmlPreview: html ? html.substring(0, 200) : 'No HTML generated'
            });

            elizaLogger.debug("Sending via Resend...");
            const response = await this.provider.sendEmail({
                ...options,
                from: options.from || this.secrets.OWNER_EMAIL || 'onboarding@resend.dev',
                subject: content.subject,
                body: plainText,
                text: plainText,
                html: html,
                headers: {
                    ...options.headers,
                    'X-Template-ID': options.template || 'default',
                    'X-Email-Priority': content.metadata.priority
                },
                tags: [
                    ...(options.tags || []),
                    { name: 'template', value: options.template || 'default' },
                    { name: 'priority', value: content.metadata.priority }
                ]
            });
            elizaLogger.debug("Resend API response:", response);

            return {
                id: response.id,
                provider: 'resend',
                status: 'success',
                timestamp: new Date()
            };

        } catch (error) {
            elizaLogger.error("Failed to send email:", {
                error,
                errorMessage: error instanceof Error ? error.message : String(error),
                options: {
                    to: options.to,
                    subject: content.subject,
                    blocksCount: content.blocks?.length
                }
            });
            throw error;
        }
    }

    private generatePlainText(content: GeneratedEmailContent): string {
        const parts: string[] = [content.subject, ''];

        content.blocks.forEach(block => {
            if (block.type === 'bulletList' && Array.isArray(block.content)) {
                parts.push(block.content.map(item => `• ${item}`).join('\n'));
            } else if (block.type === 'heading') {
                parts.push(`\n${typeof block.content === 'string' ? block.content.toUpperCase() : ''}\n`);
            } else {
                parts.push(block.content.toString());
            }
            parts.push(''); // Add spacing between blocks
        });

        return parts.join('\n');
    }
}