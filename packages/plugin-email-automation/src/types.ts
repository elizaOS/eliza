import { z } from "zod";
import { IAgentRuntime as CoreAgentRuntime, Memory, State } from "@elizaos/core";

export interface EmailOptions {
    from: string;
    to: string | string[];
    subject: string;
    body: string;
    bcc?: string | string[];
    cc?: string | string[];
    replyTo?: string | string[];
    html?: string;
    text?: string;
    scheduledAt?: string;
    headers?: Record<string, string>;
    attachments?: Array<{
        filename: string;
        content: Buffer | string;
        path?: string;
        contentType?: string;
    }>;
    tags?: Array<{
        name: string;
        value: string;
    }>;
    template?: string;
    variables?: Record<string, unknown>;
    theme?: 'light' | 'dark' | 'custom';
    style?: Record<string, string>;
}

export type PoweredByOptions = {
    text: string;
    link: string;
} | false;

export const SendEmailSchema = z.object({
    from: z.string().email(),
    to: z.union([z.string().email(), z.array(z.string().email())]),
    cc: z.union([z.string().email(), z.array(z.string().email())]).optional(),
    bcc: z.union([z.string().email(), z.array(z.string().email())]).optional(),
    replyTo: z.union([z.string().email(), z.array(z.string().email())]).optional(),
    subject: z.string(),
    body: z.string(),
    text: z.string().optional(),
    headers: z.record(z.string()).optional(),
    attachments: z.array(z.object({
        filename: z.string(),
        content: z.union([z.instanceof(Buffer), z.string()]),
        path: z.string().optional(),
        contentType: z.string().optional()
    })).optional(),
    tags: z.array(z.object({
        name: z.string(),
        value: z.string()
    })).optional()
});

export type SendEmailContent = z.infer<typeof SendEmailSchema>;

export interface EmailServiceOptions {
    RESEND_API_KEY: string;
    OWNER_EMAIL?: string;
}

export interface EmailProviderResponse {
    id: string;
    provider: string;
    status: 'success' | 'failed';
    timestamp: Date;
}

export interface IEmailProvider {
    send(params: EmailParams): Promise<EmailProviderResponse>;
    validateConfig(): boolean;
}

export interface EmailParams {
    to: string[];
    from?: string;
    cc?: string[];
    subject: string;
    body: string;
    attachments?: EmailAttachment[];
}

export interface EmailAttachment {
    filename: string;
    content: Buffer;
    contentType: string;
}

export interface ResendConfig {
    apiKey: string;
    defaultFrom?: string;
}

export interface EmailProviderError extends Error {
    provider: string;
    originalError: unknown;
}

export interface EmailConfig {
    poweredBy?: boolean | {
        text?: string;
        link?: string;
    };
}

export const EmailContentSchema = z.object({
    subject: z.string().min(1),
    body: z.string().min(1)
});

export type EmailContent = z.infer<typeof EmailContentSchema>;

export const EmailResponseSchema = z.object({
    analysis: z.object({
        purpose: z.string(),
        tone: z.string(),
        keyPoints: z.array(z.string()),
        urgency: z.string()
    }),
    email: z.object({
        subject: z.string(),
        html: z.string().refine(html => html.endsWith('</p>'), {
            message: 'HTML content must be complete'
        }),
        to: z.array(z.string().email()),
        from: z.string().email(),
        tags: z.array(z.string()).optional()
    })
});

export interface EmailResponse {
    id: string;
    error?: {
        message: string;
        code: string;
    };
}

export interface EmailBlock {
    type: "paragraph" | "bulletList" | "heading" | "signature" | "callout" | "banner";
    content: string | string[];
    metadata?: {
        style?: string;
        className?: string;
        importance?: "low" | "medium" | "high";
    };
}

export interface GeneratedEmailContent {
    subject: string;
    blocks: EmailBlock[];
    metadata: {
        tone: string;
        intent: string;
        priority: 'low' | 'medium' | 'high';
        language?: string;
    };
}

export interface EmailTemplate {
    id: string;
    name: string;
    html: string;
    variables: string[];
    defaultStyle?: Record<string, string>;
    promptTemplate?: string;
    contextRules?: {
        tone?: string[];
        topics?: string[];
        maxLength?: number;
        customVariables?: Record<string, string>;
    };
}

export interface EmailAutomationConfig {
    templates: {
        followUp?: EmailTemplate;
        reminder?: EmailTemplate;
        engagement?: EmailTemplate;
        [key: string]: EmailTemplate | undefined;
    };
    rules: AutomationRule[];
    promptDefaults?: {
        systemPrompt?: string;
        userPrompt?: string;
        generatePrompt?: (context: EmailContext) => Promise<string>;
    };
}

export interface LLMEmailPrompt {
    content: string;
    format?: 'bullet' | 'paragraph';
    tone?: string;
    language?: string;
    style?: 'casual' | 'formal' | 'technical';
    functionCall: {
        name: 'generateEmail';
        parameters: Record<string, unknown>;
    };
}

export interface EmailPrompt {
    content: string;
    format?: 'bullet' | 'paragraph';
    tone?: 'professional' | 'casual' | 'formal' | 'friendly' | 'urgent';
    language?: string;
    style?: 'casual' | 'formal' | 'technical';
}

export interface EmailGenerationOptions {
    content: string;
    format?: 'bullet' | 'paragraph';
    tone?: 'professional' | 'casual' | 'formal' | 'friendly' | 'urgent';
    language?: string;
    style?: 'casual' | 'formal' | 'technical';
}

export interface GenerateTextOptions {
    context: string;
    modelClass: string;
    tools?: {
        [key: string]: {
            type: "function";
            parameters: any;
            description?: string;
        };
    };
}

export type IAgentRuntime = CoreAgentRuntime;

export const EmailMetadataSchema = z.object({
    tone: z.string().describe('The overall tone of the email'),
    intent: z.string().describe('The primary purpose of the email'),
    priority: z.enum(['low', 'medium', 'high']).describe('The priority level of the email'),
    language: z.string().optional().describe('The language to use for the email'),
    theme: z.enum(['light', 'dark', 'custom']).optional().describe('The email theme to use')
});

export interface AutomationRule {
    id: string;
    name: string;
    trigger: EmailTrigger;
    conditions: EmailCondition[];
    templateId: string;
    cooldown?: number; // minutes
}

export interface EmailCondition {
    evaluate(context: EmailContext): boolean;
}

export interface EmailContext {
    memory: Memory;
    state: State;
    metadata: Record<string, any>;
    timestamp: Date;
    conversationId: string;
}

export type EmailTrigger =
    | 'follow_up'
    | 'reminder'
    | 'engagement'
    | 'inactive';

// Example condition implementations
export class FollowUpCondition implements EmailCondition {
    evaluate(context: EmailContext): boolean {
        return context.metadata.requiresFollowUp === true;
    }
}

export class InactiveCondition implements EmailCondition {
    private readonly thresholdHours: number;

    constructor(thresholdHours: number = 24) {
        this.thresholdHours = thresholdHours;
    }

    evaluate(context: EmailContext): boolean {
        const lastActivity = context.timestamp;
        const hoursSinceActivity =
            (new Date().getTime() - lastActivity.getTime()) / (1000 * 60 * 60);
        return hoursSinceActivity >= this.thresholdHours;
    }
}

export interface EmailPluginConfig {
    defaultToEmail: string;
    defaultFromEmail: string;
    evaluationRules?: {
        maxEmailsPerDay?: number;
        cooldownMinutes?: number;
        blacklistedDomains?: string[];
    };
    templates?: {
        shouldEmailPrompt?: string;
        connectionEmailTemplate?: string;
    };
}

export interface EmailTriggerContext extends EmailContext {
    recentInteractions: {
        lastEmailSent?: Date;
        emailCount24h: number;
        conversationActivity: {
            lastMessage: Date;
            messageCount: number;
        };
    };
    userPreferences?: {
        emailFrequency?: 'low' | 'medium' | 'high';
        timezone?: string;
        preferredTimes?: string[];
    };
}