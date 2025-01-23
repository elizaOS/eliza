export enum EmailOutgoingProvider {
    GMAIL = "gmail",
    SMTP = "smtp",
}

export enum EmailIncomingProvider {
    IMAP = "imap",
}
interface BaseConfig {
    provider: EmailOutgoingProvider;
    user: string;
    pass: string;
}
export interface GmailConfig extends BaseConfig {
    service: string;
}
export interface SmtpConfig extends BaseConfig {
    host: string;
    port: number;
    secure: boolean;
}

export interface ImapConfig {
    provider: EmailIncomingProvider;
    host: string;
    port: number;
    user: string;
    pass: string;
}

export type OutgoingConfig = GmailConfig | SmtpConfig;
export type IncomingConfig = ImapConfig;
