import { Resend } from "resend";

/**
 * Pluggable email provider interface.
 * Swap implementations without touching EmailAuth logic.
 */
export interface EmailProvider {
  send(
    to: string,
    subject: string,
    text: string,
    html?: string,
    options?: { replyTo?: string },
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// ResendProvider — production provider backed by resend.com
// ---------------------------------------------------------------------------

export interface ResendProviderConfig {
  apiKey: string;
  from: string; // e.g. "Steward <login@steward.fi>"
  replyTo?: string;
}

export class ResendProvider implements EmailProvider {
  private client: Resend;
  private from: string;
  private replyTo?: string;

  constructor(config: ResendProviderConfig) {
    this.client = new Resend(config.apiKey);
    this.from = config.from;
    this.replyTo = config.replyTo;
  }

  async send(
    to: string,
    subject: string,
    text: string,
    html?: string,
    options?: { replyTo?: string },
  ): Promise<void> {
    const { error } = await this.client.emails.send({
      from: this.from,
      to,
      subject,
      text,
      ...(options?.replyTo || this.replyTo ? { replyTo: options?.replyTo || this.replyTo } : {}),
      ...(html ? { html } : {}),
    });

    if (error) {
      throw new Error(`Resend error: ${error.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// ConsoleProvider — development / testing provider (logs to stdout)
// ---------------------------------------------------------------------------

export class ConsoleProvider implements EmailProvider {
  async send(
    to: string,
    subject: string,
    text: string,
    _html?: string,
    options?: { replyTo?: string },
  ): Promise<void> {
    console.log(
      [
        "─────────────────────────────────────────",
        `[ConsoleProvider] Magic link email`,
        `To:      ${to}`,
        `Subject: ${subject}`,
        ...(options?.replyTo ? [`Reply-To: ${options.replyTo}`] : []),
        "",
        text,
        "─────────────────────────────────────────",
      ].join("\n"),
    );
  }
}
