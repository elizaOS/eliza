import { Client, elizaLogger, IAgentRuntime, ServiceType } from "@elizaos/core";
import MailNotifier, { Config, EmailContent } from "mail-notifier";
import nodemailer, { Transporter } from "nodemailer";
import {
    validateIncomingEmailConfig,
    validateOutgoingEmailConfig,
} from "../config/email";
import {
    OutgoingConfig,
    EmailOutgoingProvider,
    GmailConfig,
    SmtpConfig,
    SendEmailOptions,
    EmailResponse,
    IncomingConfig,
} from "../types";
import EventEmitter from "events";

class IncomingEmailManager extends EventEmitter {
    private static instance: IncomingEmailManager | null = null;
    private notifier: any;

    private constructor(config: IncomingConfig) {
        super();
        let imapSettings: Config = {
            user: config.user,
            password: config.pass,
            host: config.host,
            port: config.port,
            tls: true,
            tlsOptions: { rejectUnauthorized: false },
        };

        this.notifier = MailNotifier(imapSettings);
    }

    start() {
        this.notifier
            .on("end", () => this.notifier.start())
            .on("mail", (mail: EmailContent) => {
                this.emit("mail", mail);
            })
            .start();
    }

    stop() {
        this.notifier.stop();
    }

    listen(callback: (mail: EmailContent) => void) {
        this.notifier.on("mail", callback);
    }
    static getInstance(config: IncomingConfig): IncomingEmailManager {
        if (!this.instance) {
            if (!config) {
                // TODO - check the condition to enable Smtp
                elizaLogger.warn(
                    `IMAP configuration is missing. Unable to receive emails.`
                );
                return null;
            }
            this.instance = new IncomingEmailManager(config);
        }
        return this.instance;
    }
}

class OutgoingEmailManager {
    private static instance: OutgoingEmailManager | null = null;

    private transporter: Transporter | null = null;
    private config: OutgoingConfig | null = null;

    private constructor(config: OutgoingConfig) {
        this.config = config;
        switch (this.config?.provider) {
            case EmailOutgoingProvider.GMAIL:
                this.config = this.config as GmailConfig;
                this.transporter = nodemailer.createTransport({
                    service: "Gmail",
                    secure: false,
                    auth: {
                        user: this.config.user,
                        pass: this.config.pass,
                    },
                });
                break;
            case EmailOutgoingProvider.SMTP:
                this.config = this.config as SmtpConfig;
                this.transporter = nodemailer.createTransport({
                    host: this.config.host,
                    port: this.config.port,
                    secure: this.config.secure,
                    auth: {
                        user: this.config.user,
                        pass: this.config.pass,
                    },
                });
                break;
            default:
                throw new Error(
                    `Invalid email provider: ${this.config?.provider}`
                );
        }
    }
    async send(options: SendEmailOptions): Promise<EmailResponse> {
        const mailOptions = {
            from: options.from || this.config.user,
            to: options.to,
            subject: options.subject,
            text: options.text,
        };
        return await this.transporter?.sendMail(mailOptions);
    }

    static getInstance(config: OutgoingConfig): OutgoingEmailManager {
        if (!this.instance) {
            if (!config) {
                // TODO - check the condition to enable Smtp
                elizaLogger.warn(
                    `SMTP configuration is missing. Unable to send emails.`
                );
                return null;
            }
            this.instance = new OutgoingEmailManager(config);
        }
        return this.instance;
    }
}
export class EmailClient {
    private runtime: IAgentRuntime;
    private incomingConfig: IncomingConfig | null = null;
    private outgoingConfig: OutgoingConfig | null = null;

    private outgoingEmailManager: OutgoingEmailManager | null = null;
    private incomingEmailManager: IncomingEmailManager | null = null;

    constructor(runtime: IAgentRuntime) {
        this.runtime = runtime;
    }
    async initialize(): Promise<void> {
        this.incomingConfig = await validateIncomingEmailConfig(this.runtime);
        this.outgoingConfig = await validateOutgoingEmailConfig(this.runtime);

        this.outgoingEmailManager = OutgoingEmailManager.getInstance(
            this.outgoingConfig
        );
        this.incomingEmailManager = IncomingEmailManager.getInstance(
            this.incomingConfig
        );

        if (this.incomingEmailManager) {
            this.incomingEmailManager.start();
        }
        let incomingStatus = this.incomingEmailManager ? "✅ " : "❌ ";
        let outgoingStatus = this.outgoingEmailManager ? "✅ " : "❌ ";
        elizaLogger.info(
            `Email service initialized successfully: ${incomingStatus}Incoming - ${outgoingStatus}Outgoing`
        );
    }

    async stop(): Promise<void> {
        if (this.incomingEmailManager) {
            this.incomingEmailManager.stop();
        }
    }
    async send(options: SendEmailOptions): Promise<EmailResponse> {
        if (!this.outgoingEmailManager) {
            throw new Error(
                "Email service is not initialized for sending emails"
            );
        }
        return await this.outgoingEmailManager?.send(options);
    }

    receive(callback: (mail: EmailContent) => void): void {
        if (!this.incomingEmailManager) {
            throw new Error(
                "Email service is not initialized for receiving emails"
            );
        }
        this.incomingEmailManager?.listen(callback);
    }
}
interface ClientWithType extends Client {
    type: string;
}
export const EmailClientInterface: ClientWithType = {
    type: "email",
    start: async (runtime: IAgentRuntime) => {
        const client = new EmailClient(runtime);
        await client.initialize();
        return client;
    },
    stop: async (_runtime: IAgentRuntime) => {
        console.warn("Email client does not support stopping yet");
    },
};

export default EmailClientInterface;
