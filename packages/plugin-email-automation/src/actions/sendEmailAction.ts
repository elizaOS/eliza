import { Action, IAgentRuntime, Memory, State, Content, elizaLogger, HandlerCallback } from "@elizaos/core";
import { EmailService } from "../services/emailService";
import { EmailPrompt, GeneratedEmailContent } from "../types";
import { EmailGenerationService } from "../services/emailGenerationService";

// Define the state interface
interface EmailState extends State {
    generatedEmail?: GeneratedEmailContent;
}

export const sendEmailAction: Action = {
    name: "send_email",
    description: "Send an email using the configured email service",
    similes: ["send email", "send the email", "deliver email"],
    examples: [
        [{ user: "user1", content: { text: "Please send this email to the team" } }],
        [{ user: "user1", content: { text: "Send the email to john@example.com" } }]
    ],

    async validate(runtime: IAgentRuntime, message: Memory): Promise<boolean> {
        const content = message.content as Content;
        const text = content?.text?.toLowerCase() || '';

        // Strip Discord mention if present
        const cleanText = text.replace(/<@[0-9]+>\s*/, '').trim();

        // Check for send command
        const startsWithSend = /^(please\s+)?send(\s+an?)?\s+email/.test(cleanText);
        const hasEmailAddress = /[\w.-]+@[\w.-]+\.\w+/.test(text);

        elizaLogger.info('Send validation:', {
            originalText: text,
            cleanText,
            startsWithSend,
            hasEmailAddress,
            messageId: message.id,
            userId: message.userId
        });

        return startsWithSend && hasEmailAddress;
    },

    async handler(
        runtime: IAgentRuntime,
        message: Memory,
        state?: EmailState,
        _options: { [key: string]: unknown } = {},
        callback?: HandlerCallback
    ): Promise<boolean> {
        try {
            elizaLogger.info('Handler invoked for sendEmailAction', {
                messageId: message.id,
                userId: message.userId
            });

            // Use state directly if provided, otherwise compose it
            if (!state) {
                state = (await runtime.composeState(message)) as EmailState;
            } else {
                state = await runtime.updateRecentMessageState(state);
            }

            elizaLogger.info('Send handler started', {
                messageId: message.id,
                hasState: !!state,
                hasGeneratedEmail: !!state?.generatedEmail
            });

            // Check if we have a generated email
            if (!state?.generatedEmail) {
                elizaLogger.info('No email content found, generating first...');
                const emailService = new EmailGenerationService(runtime);
                const content = message.content as Content;

                const prompt: EmailPrompt = {
                    content: content.text,
                    tone: 'professional',
                    format: 'paragraph',
                    language: 'English'
                };

                const generatedEmail = await emailService.generateEmail(prompt);
                state.generatedEmail = {
                    subject: generatedEmail.subject,
                    blocks: generatedEmail.blocks,
                    metadata: generatedEmail.metadata
                };

                // Update state with new email
                await runtime.updateRecentMessageState(state);
            }

            // Get raw secrets string first
            const secretsStr = runtime.getSetting('secrets');
            elizaLogger.debug('Got secrets configuration', {
                hasSecrets: !!secretsStr
            });

            if (!secretsStr) {
                elizaLogger.error('Secrets configuration not found');
                if (callback) {
                    callback({
                        text: 'Email configuration not found.',
                        content: { error: 'Missing secrets' }
                    });
                }
                return false;
            }

            // Parse secrets string to object
            const secrets = typeof secretsStr === 'string' ? JSON.parse(secretsStr) : secretsStr;

            // Extract email address from message
            const emailMatch = message.content.text.match(/[\w.-]+@[\w.-]+\.\w+/);
            elizaLogger.info('Extracted email address', {
                hasMatch: !!emailMatch,
                email: emailMatch ? emailMatch[0] : null
            });

            if (!emailMatch) {
                elizaLogger.error('No valid email address found');
                if (callback) {
                    callback({
                        text: 'Please provide a valid email address.',
                        content: { error: 'Invalid email' }
                    });
                }
                return false;
            }

            // Validate email content
            if (!state?.generatedEmail) {
                elizaLogger.error('No generated email content available', {
                    stateContent: state ? Object.keys(state) : []
                });
                if (callback) {
                    callback({
                        text: 'Please generate an email first using the generate command.',
                        content: { error: 'No content' }
                    });
                }
                return false;
            }

            const emailService = new EmailService({
                RESEND_API_KEY: secrets.RESEND_API_KEY,
                OWNER_EMAIL: secrets.OWNER_EMAIL || secrets.DEFAULT_FROM_EMAIL
            });

            elizaLogger.info('Sending email', {
                to: emailMatch[0],
                hasSubject: !!state.generatedEmail.subject,
                blockCount: state.generatedEmail.blocks.length
            });

            await emailService.sendEmail(state.generatedEmail, {
                from: secrets.OWNER_EMAIL || 'onboarding@resend.dev',
                to: [emailMatch[0]]
            });

            elizaLogger.info('Email sent successfully');
            if (callback) {
                callback({
                    text: `Email sent successfully to ${emailMatch[0]}!`,
                    content: { success: true }
                });
            }

            return true;

        } catch (error) {
            elizaLogger.error('Failed to handle email action:', error);
            if (callback) {
                callback({
                    text: 'Failed to send email. Please try again.',
                    content: { error: 'Send failed' }
                });
            }
            return false;
        }
    }
};