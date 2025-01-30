import { Resend } from "resend";
import { elizaLogger } from "@elizaos/core";
import {
    EmailOptions,
    EmailResponse,
    EmailProviderError,
    EmailProviderResponse
} from "../types";
import { createEmailProviderError } from './errors';

export class ResendProvider {
    private client: Resend;
    private readonly retryAttempts = 3;
    private readonly retryDelay = 1000; // ms

    constructor(apiKey: string) {
        this.client = new Resend(apiKey);
    }

    async sendEmail(options: EmailOptions): Promise<EmailProviderResponse> {
        let lastError: Error | null = null;

        for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
            try {
                const response = await this.client.emails.send({
                    from: options.from,
                    to: options.to,
                    subject: options.subject,
                    html: options.html || options.body,
                    text: options.text,
                    bcc: options.bcc,
                    cc: options.cc,
                    reply_to: options.replyTo,
                    headers: options.headers,
                    attachments: options.attachments,
                    tags: options.tags
                });

                elizaLogger.debug('Email sent successfully', {
                    id: (response as any).id,
                    attempt
                });

                return {
                    id: (response as any).id,
                    provider: 'resend',
                    status: 'success',
                    timestamp: new Date()
                };

            } catch (error) {
                lastError = error as Error;
                elizaLogger.error(`Resend attempt ${attempt} failed:`, {
                    error,
                    options: {
                        to: options.to,
                        subject: options.subject
                    }
                });

                if (this.shouldRetry(error) && attempt < this.retryAttempts) {
                    await this.delay(attempt * this.retryDelay);
                    continue;
                }
                break;
            }
        }

        throw createEmailProviderError(
            'resend',
            lastError as Error,
            {
                attempts: this.retryAttempts,
                lastAttemptAt: new Date().toISOString()
            }
        );
    }

    private shouldRetry(error: unknown): boolean {
        if (error instanceof Error) {
            // Retry on network errors or rate limits
            return error.message.includes('network') ||
                   error.message.includes('rate limit') ||
                   error.message.includes('timeout');
        }
        return false;
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async validateConfig(): Promise<boolean> {
        try {
            // Try to get account info or similar lightweight call
            await this.client.emails.send({
                from: 'test@resend.dev',
                to: 'validate@resend.dev',
                subject: 'Configuration Test',
                text: 'Testing configuration'
            });
            return true;
        } catch (error) {
            if (error instanceof Error &&
                error.message.includes('unauthorized')) {
                return false;
            }
            // Other errors might indicate valid config but other issues
            return true;
        }
    }
}