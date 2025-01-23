import { Service } from "@elizaos/core";
import { EmailContent } from "mail-notifier";

interface EmailAttachment {
    filename: string;
    path: string;
    cid?: string;
}

export interface SendEmailOptions {
    from?: string;
    to: string | string[];
    subject: string;
    text?: string;
    html?: string;
    attachments?: EmailAttachment[];
    cc?: string | string[];
    bcc?: string | string[];
    replyTo?: string;
}

export interface EmailResponse {
    success: boolean;
    messageId?: string;
    response?: string;
    error?: string;
}

export interface IEmailService extends Service {
    send(options: SendEmailOptions): Promise<EmailResponse>;
    receive(callback: (mail: EmailContent) => void): void;
}
