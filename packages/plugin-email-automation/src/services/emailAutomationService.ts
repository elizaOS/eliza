import { Service, ServiceType, IAgentRuntime, elizaLogger, Memory, ModelClass, generateText, composeContext } from "@elizaos/core";
import { EmailService } from "./emailService";
import { EmailContext, EmailOptions, GeneratedEmailContent } from "../types";
import { shouldEmailTemplate } from "../templates/shouldEmail";
import { emailFormatTemplate } from "../templates/emailFormat";

export class EmailAutomationService extends Service {
    static get serviceType(): ServiceType {
        return ServiceType.EMAIL_AUTOMATION;
    }

    get serviceType(): ServiceType {
        return ServiceType.EMAIL_AUTOMATION;
    }

    private emailService!: EmailService;
    private runtime!: IAgentRuntime;

    constructor() {
        super();
    }

    async initialize(runtime: IAgentRuntime): Promise<void> {
        this.runtime = runtime;

        // Check if enabled
        const isEnabled = runtime.getSetting('EMAIL_AUTOMATION_ENABLED')?.toLowerCase() === 'true' || false;
        elizaLogger.debug(`📋 Email Automation Enabled: ${isEnabled}`);

        if (!isEnabled) {
            elizaLogger.debug("❌ Email automation is disabled");
            return;
        }

        elizaLogger.info("🔄 Initializing Email Automation Service...");

        try {
            // Required settings
            const resendApiKey = runtime.getSetting('RESEND_API_KEY');
            const defaultToEmail = runtime.getSetting('DEFAULT_TO_EMAIL');
            const defaultFromEmail = runtime.getSetting('DEFAULT_FROM_EMAIL');

            elizaLogger.debug("🔑 Checking configuration:", {
                hasApiKey: !!resendApiKey,
                hasToEmail: !!defaultToEmail,
                hasFromEmail: !!defaultFromEmail
            });

            if (!resendApiKey || !defaultToEmail || !defaultFromEmail) {
                throw new Error('Missing required email configuration: RESEND_API_KEY, DEFAULT_TO_EMAIL, DEFAULT_FROM_EMAIL');
            }

            this.emailService = new EmailService({
                RESEND_API_KEY: resendApiKey,
                OWNER_EMAIL: defaultToEmail
            });

            elizaLogger.success(`✅ Service ${this.serviceType} initialized successfully`);
            elizaLogger.info("📧 Email service ready to process messages");
        } catch (error) {
            elizaLogger.error("❌ Failed to initialize email service:", error);
            // Don't rethrow - let the service gracefully handle missing config
        }
    }

    private async buildContext(memory: Memory): Promise<EmailContext> {
        elizaLogger.debug("🔄 Building email context for message:", {
            userId: memory.userId,
            messageId: memory.id,
            contentLength: memory.content.text.length
        });

        const state = await this.runtime.composeState(memory);

        // Include message content in state for template access
        if (state) {
            state.message = {
                content: memory.content,
                userId: memory.userId,
                id: memory.id
            };
        }

        return {
            memory,
            state,
            metadata: state?.metadata || {},
            timestamp: new Date(),
            conversationId: memory.id || ''
        };
    }

    async evaluateMessage(memory: Memory): Promise<boolean> {
        if (!this.emailService) {
            elizaLogger.error("❌ Email service not initialized");
            throw new Error('Missing required email configuration');
        }

        try {
            // Build context first
            const context = await this.buildContext(memory);
            elizaLogger.info("🔍 Evaluating accumulated conversation for email automation:", {
                text: memory.content.text,
                userId: memory.userId,
                roomId: memory.roomId
            });

            // Check if we should send an email
            const shouldEmail = await this.shouldSendEmail(context);

            if (shouldEmail) {
                elizaLogger.info("✨ Accumulated context triggered email automation, preparing to send...");
                await this.handleEmailTrigger(context);
                elizaLogger.success("✅ Email processed and sent successfully");
                return true;
            }

            elizaLogger.info("⏭️ Current context does not warrant email automation");
            return false;

        } catch (error) {
            elizaLogger.error("❌ Error evaluating message for email:", error);
            return false;
        }
    }

    private async shouldSendEmail(context: EmailContext): Promise<boolean> {
        elizaLogger.info("🤔 Evaluating if message should trigger email...");
        const customPrompt = this.runtime.getSetting('EMAIL_EVALUATION_PROMPT');
        const template = customPrompt || shouldEmailTemplate;

        elizaLogger.debug("📝 Using template:", {
            isCustom: !!customPrompt,
            templateLength: template.length
        });

        const decision = await generateText({
            runtime: this.runtime,
            context: composeContext({
                state: context.state,
                template
            }),
            modelClass: ModelClass.SMALL
        });

        elizaLogger.info("📝 Final composed prompt:", {
            prompt: composeContext({
                state: context.state,
                template
            })
        });

        const shouldEmail = decision.includes("[EMAIL]");
        elizaLogger.info(`📊 Email decision: ${shouldEmail ? "✅ Should send" : "❌ Should not send"}`, {
            decision: decision.trim(),
            trigger: shouldEmail
        });

        return shouldEmail;
    }

    private async handleEmailTrigger(context: EmailContext) {
        try {
            // Extract user info and format Discord ID if present
            const userInfo = {
                id: context.memory.userId,
                displayName: this.formatUserIdentifier(context.memory.userId),
                platform: this.detectPlatform(context.memory.userId),
                metadata: context.metadata || {}
            };

            // Parse message content for relevant details
            const messageText = context.memory.content.text;
            const enhancedContext = {
                ...context.state,
                userInfo,
                platform: userInfo.platform,
                originalMessage: messageText,
                // Let the LLM extract and structure the details from the original message
                // rather than hardcoding values
                messageContent: messageText
            };

            // Generate content with enhanced context
            const formattedEmail = await generateText({
                runtime: this.runtime,
                context: composeContext({
                    state: enhancedContext,
                    template: emailFormatTemplate
                }),
                modelClass: ModelClass.SMALL
            });

            // Parse and validate sections
            const sections = this.parseFormattedEmail(formattedEmail);

            // Add explicit validation with helpful errors
            if (!sections.background) {
                elizaLogger.error("Missing background section in generated email");
                throw new Error("Email generation failed: Missing background section");
            }

            if (!sections.keyPoints || sections.keyPoints.length === 0) {
                elizaLogger.error("Missing or empty key points in generated email");
                throw new Error("Email generation failed: No key points generated");
            }

            // If validation passes, create email content
            const emailContent: GeneratedEmailContent = {
                subject: sections.subject,
                blocks: [
                    {
                        type: 'paragraph',
                        content: sections.background,
                        metadata: {
                            style: 'margin-bottom: 1.5em;'
                        }
                    },
                    {
                        type: 'heading',
                        content: 'Key Points'
                    },
                    {
                        type: 'bulletList',
                        content: sections.keyPoints
                    }
                ],
                metadata: {
                    tone: 'professional',
                    intent: 'connection_request',
                    priority: 'high'
                }
            };

            // Add optional technical details if present
            if (sections.technicalDetails?.length) {
                emailContent.blocks.push(
                    {
                        type: 'heading',
                        content: 'Technical Details'
                    },
                    {
                        type: 'bulletList',
                        content: sections.technicalDetails
                    }
                );
            }

            // Add next steps if present
            if (sections.nextSteps?.length) {
                emailContent.blocks.push(
                    {
                        type: 'heading',
                        content: 'Next Steps'
                    },
                    {
                        type: 'bulletList',
                        content: sections.nextSteps
                    }
                );
            }

            elizaLogger.info("📋 Email content prepared:", {
                subject: emailContent.subject,
                blocksCount: emailContent.blocks.length,
                metadata: emailContent.metadata
            });

            const emailOptions = {
                to: this.runtime.getSetting('DEFAULT_TO_EMAIL') || '',
                from: this.runtime.getSetting('DEFAULT_FROM_EMAIL') || '',
                headers: {
                    'X-Conversation-ID': context.conversationId,
                    'X-User-ID': userInfo.id,
                    'X-Platform': userInfo.platform,
                    'X-Display-Name': userInfo.displayName
                }
            };

            elizaLogger.info("📤 Composing email...", {
                to: emailOptions.to,
                from: emailOptions.from,
                conversationId: context.conversationId
            });

            await this.emailService.sendEmail(emailContent, emailOptions);
        } catch (error) {
            elizaLogger.error("❌ Email generation failed:", { error, context });
            throw error;
        }
    }

    private parseFormattedEmail(formattedEmail: string): {
        subject: string;
        background: string;
        keyPoints: string[];
        technicalDetails?: string[];
        nextSteps: string[];
    } {
        const sections: any = {};

        try {
            // Extract subject
            const subjectMatch = formattedEmail.match(/Subject: (.+?)(?:\n|$)/);
            sections.subject = subjectMatch?.[1]?.trim() || 'New Connection Request';
            elizaLogger.debug("📝 Parsed subject:", sections.subject);

            // Extract background
            const backgroundMatch = formattedEmail.match(/Background:\n([\s\S]*?)(?=\n\n|Key Points:|$)/);
            sections.background = backgroundMatch?.[1]?.trim() || '';
            elizaLogger.debug("📝 Parsed background:", {
                found: !!backgroundMatch,
                length: sections.background.length
            });

            // Extract key points
            const keyPointsMatch = formattedEmail.match(/Key Points:\n([\s\S]*?)(?=\n\n|Technical Details:|Next Steps:|$)/);
            sections.keyPoints = keyPointsMatch?.[1]
                ?.split('\n')
                .filter(point => point.trim())
                .map(point => point.trim().replace(/^[•\-]\s*/, '')) || [];
            elizaLogger.debug("📝 Parsed key points:", {
                count: sections.keyPoints.length,
                points: sections.keyPoints
            });

            // Extract technical details (optional)
            const technicalMatch = formattedEmail.match(/Technical Details:\n([\s\S]*?)(?=\n\n|Next Steps:|$)/);
            if (technicalMatch) {
                sections.technicalDetails = technicalMatch[1]
                    ?.split('\n')
                    .filter(point => point.trim())
                    .map(point => point.trim().replace(/^[•\-]\s*/, ''));
                elizaLogger.debug("📝 Parsed technical details:", {
                    count: sections.technicalDetails.length
                });
            }

            // Extract next steps
            const nextStepsMatch = formattedEmail.match(/Next Steps:\n([\s\S]*?)(?=\n\n|$)/);
            sections.nextSteps = nextStepsMatch?.[1]
                ?.split('\n')
                .filter(step => step.trim())
                .map(step => step.trim().replace(/^(\d+\.|\-|\•)\s*/, '')) || [];
            elizaLogger.debug("📝 Parsed next steps:", {
                count: sections.nextSteps.length
            });

            // Validate required sections
            if (!sections.subject || !sections.background || !sections.keyPoints.length) {
                elizaLogger.warn("⚠️ Missing required sections:", {
                    hasSubject: !!sections.subject,
                    hasBackground: !!sections.background,
                    keyPointsCount: sections.keyPoints.length
                });
            }

            return sections;
        } catch (error) {
            elizaLogger.error("❌ Error parsing email format:", {
                error: error instanceof Error ? error.message : String(error),
                sections: Object.keys(sections)
            });
            throw new Error(`Failed to parse email format: ${error}`);
        }
    }

    private formatUserIdentifier(userId: string): string {
        // If userId is a Discord ID (typically a large number)
        if (/^\d{17,19}$/.test(userId)) {
            return `Discord User ${userId}`;
        }
        // For email addresses
        if (userId.includes('@')) {
            return userId;
        }
        // Default format
        return `User ${userId}`;
    }

    private detectPlatform(userId: string): string {
        // Discord IDs are typically 17-19 digit numbers
        if (/^\d{17,19}$/.test(userId)) {
            return 'discord';
        }
        // Email format
        if (userId.includes('@')) {
            return 'email';
        }
        // Default platform
        return 'unknown';
    }
}