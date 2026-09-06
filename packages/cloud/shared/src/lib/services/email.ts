/**
 * Email service for sending transactional emails via SendGrid or SMTP.
 */

import sgMail from "@sendgrid/mail";
import type { Transporter } from "nodemailer";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { getEmailMessages, interpolateMessage } from "../email/messages";
import type {
  AutoTopUpDisabledEmailData,
  AutoTopUpSuccessEmailData,
  ContainerShutdownWarningEmailData,
  EmailOptions,
  InviteEmailData,
  LowCreditsEmailData,
  PurchaseConfirmationEmailData,
  WelcomeEmailData,
} from "../email/types";
import { logger } from "../utils/logger";

/**
 * Typed configuration error for an invalid SMTP port.
 * Thrown at the initialization boundary when SMTP_PORT is present but malformed,
 * so operator misconfiguration is not masked as healthy SMTP setup.
 */
export class SmtpPortConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmtpPortConfigError";
  }
}

/**
 * Canonical decimal-integer grammar: "0" or a non-zero-leading digit string.
 * Rejects sign, decimals, exponent, hex, or trailing junk.
 */
const CANONICAL_DECIMAL_INTEGER_GRAMMAR = /^(?:0|[1-9][0-9]*)$/;

/**
 * Strictly resolves an SMTP port string.
 *
 * Validates the complete trimmed string against the canonical decimal-integer
 * grammar before conversion, then enforces the TCP port range 1..65535.
 * Throws {@link SmtpPortConfigError} for any present invalid value.
 *
 * @param raw - Raw SMTP_PORT value (trimmed before validation).
 * @returns Parsed port number in 1..65535.
 */
export function resolveSmtpPort(raw: string | undefined | null): number {
  if (typeof raw !== "string") {
    throw new SmtpPortConfigError("Invalid SMTP_PORT: port string is required");
  }
  const trimmed = raw.trim();
  if (!CANONICAL_DECIMAL_INTEGER_GRAMMAR.test(trimmed)) {
    throw new SmtpPortConfigError(
      `Invalid SMTP_PORT "${raw}": must be a canonical decimal integer`,
    );
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
    throw new SmtpPortConfigError(`Invalid SMTP_PORT "${raw}": must be in range 1..65535`);
  }
  return parsed;
}

/** Submission receipts are server-only; acceptance never proves recipient delivery. */
export type EmailDispatchResult =
  | { status: "unavailable"; reason: "not_configured" | "invalid_configuration" }
  | { status: "accepted"; provider: "smtp" | "sendgrid"; messageId: string }
  | { status: "rejected"; provider: "smtp" | "sendgrid"; reason: "provider_rejected" }
  | {
      status: "uncertain";
      provider: "smtp" | "sendgrid";
      reason: "transport_error" | "missing_receipt" | "partial_acceptance";
      messageId: string | null;
    };

function receiptId(value: unknown): string | null {
  // Transport metadata is untrusted. Never persist response bodies or headers
  // masquerading as a message ID, and never truncate a correlation identifier.
  return typeof value === "string" && /^[A-Za-z0-9._:@<>+=/-]{1,256}$/.test(value) ? value : null;
}

/**
 * Email service supporting SendGrid API and SMTP.
 */
export class EmailService {
  private initialized = false;
  private fromEmail: string | null = null;
  private smtpTransporter: Transporter<SMTPTransport.SentMessageInfo> | null = null;
  private useSmtp = false;

  private initialize(): void {
    if (this.initialized) return;

    this.fromEmail =
      process.env.SENDGRID_FROM_EMAIL || process.env.SMTP_FROM || "noreply@eliza.app";

    if (process.env.SMTP_HOST && process.env.SMTP_PASSWORD) {
      logger.info("[EmailService] Using SMTP configuration");
      const port = resolveSmtpPort(process.env.SMTP_PORT);
      this.smtpTransporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port,
        secure: false,
        auth: {
          user: process.env.SMTP_USERNAME || "apikey",
          pass: process.env.SMTP_PASSWORD,
        },
      });
      this.useSmtp = true;
      this.initialized = true;
      logger.info("[EmailService] Initialized with SMTP");
      return;
    }

    const apiKey = process.env.SENDGRID_API_KEY;
    if (!apiKey) {
      logger.warn("[EmailService] No email configuration found");
      this.initialized = false;
      return;
    }

    logger.info("[EmailService] Using SendGrid API configuration");
    sgMail.setApiKey(apiKey);
    this.initialized = true;
    logger.info("[EmailService] Initialized with SendGrid API");
  }

  /**
   * Compatibility API: resolves false when unconfigured and true after a
   * resolved transport submission; transport failures continue to reject.
   * New durable callers must use dispatch and persist its typed receipt.
   */
  async send(options: EmailOptions): Promise<boolean> {
    const result = await this.submit(options);
    return result.status !== "unavailable";
  }

  /**
   * Submits once and records what the provider actually acknowledged. An
   * uncertain result requires reconciliation, never an automatic resend.
   */
  async dispatch(options: EmailOptions): Promise<EmailDispatchResult> {
    try {
      return await this.submit(options);
    } catch (error) {
      // error-policy:J1 the mail boundary reports acceptance uncertainty without
      // leaking recipients, credentials, transport responses, or message bodies.
      if (error instanceof SmtpPortConfigError) {
        return { status: "unavailable", reason: "invalid_configuration" };
      }
      const provider = this.useSmtp ? "smtp" : "sendgrid";
      const responseCode =
        error !== null && typeof error === "object"
          ? this.useSmtp && "responseCode" in error
            ? error.responseCode
            : "code" in error
              ? error.code
              : null
          : null;
      if (
        typeof responseCode === "number" &&
        responseCode >= 400 &&
        responseCode < 600 &&
        (this.useSmtp || (responseCode < 500 && responseCode !== 408))
      ) {
        return { status: "rejected", provider, reason: "provider_rejected" };
      }
      return { status: "uncertain", provider, reason: "transport_error", messageId: null };
    }
  }

  private async submit(options: EmailOptions): Promise<EmailDispatchResult> {
    this.initialize();
    if (!this.initialized) {
      return { status: "unavailable", reason: "not_configured" };
    }
    if (this.useSmtp && this.smtpTransporter) {
      const result = await this.smtpTransporter.sendMail({
        from: options.from || this.fromEmail!,
        to: options.to,
        subject: options.subject,
        text: options.text,
        html: options.html,
        replyTo: options.replyTo,
        attachments: options.attachments?.map((att) => ({
          filename: att.filename,
          content: Buffer.from(att.content, "base64"),
          contentType: att.type,
        })),
      });
      const messageId = receiptId(result.messageId);
      if (result.rejected?.length > 0 || result.pending?.length > 0) {
        return {
          status: "uncertain",
          provider: "smtp",
          reason: "partial_acceptance",
          messageId,
        };
      }
      if (
        !messageId ||
        !result.accepted?.length ||
        result.accepted.length !== result.envelope?.to.length
      ) {
        return { status: "uncertain", provider: "smtp", reason: "missing_receipt", messageId };
      }
      return { status: "accepted", provider: "smtp", messageId };
    }
    const [response] = await sgMail.send({
      to: options.to,
      from: options.from || this.fromEmail!,
      subject: options.subject,
      text: options.text,
      html: options.html,
      replyTo: options.replyTo,
      attachments: options.attachments,
    });
    const messageId = receiptId(response.headers?.["x-message-id"]);
    if (response.statusCode >= 400 && response.statusCode < 600) {
      return { status: "rejected", provider: "sendgrid", reason: "provider_rejected" };
    }
    if (response.statusCode !== 202 || !messageId) {
      return { status: "uncertain", provider: "sendgrid", reason: "missing_receipt", messageId };
    }
    return { status: "accepted", provider: "sendgrid", messageId };
  }

  /**
   * Sends a welcome email to new users.
   *
   * @param data - Welcome email data.
   * @returns True if sent successfully.
   */
  async sendWelcomeEmail(data: WelcomeEmailData): Promise<boolean> {
    const { renderWelcomeTemplate } = await import("../email/utils/template-renderer");
    const { html, text } = renderWelcomeTemplate(data);
    const messages = getEmailMessages(data.locale);

    return this.send({
      to: data.email,
      subject: messages.welcome.subject,
      html,
      text,
    });
  }

  /**
   * Sends a low credits warning email.
   *
   * @param data - Low credits email data.
   * @returns True if sent successfully.
   */
  async sendLowCreditsEmail(data: LowCreditsEmailData): Promise<boolean> {
    const { renderLowCreditsTemplate } = await import("../email/utils/template-renderer");
    const { html, text } = renderLowCreditsTemplate(data);
    const messages = getEmailMessages(data.locale);

    return this.send({
      to: data.email,
      subject: messages.lowCredits.subject,
      html,
      text,
    });
  }

  /**
   * Sends an organization invite email.
   *
   * @param data - Invite email data.
   * @returns True if sent successfully.
   */
  async sendInviteEmail(data: InviteEmailData): Promise<boolean> {
    const { renderInviteTemplate } = await import("../email/utils/template-renderer");
    const { html, text } = renderInviteTemplate(data);
    const messages = getEmailMessages(data.locale);

    return this.send({
      to: data.email,
      subject: interpolateMessage(messages.invite.subject, {
        organizationName: data.organizationName,
      }),
      html,
      text,
    });
  }

  /**
   * Sends an auto top-up success notification email.
   *
   * @param data - Auto top-up success email data.
   * @returns True if sent successfully.
   */
  async sendAutoTopUpSuccessEmail(data: AutoTopUpSuccessEmailData): Promise<boolean> {
    const { renderAutoTopUpSuccessTemplate } = await import("../email/utils/template-renderer");
    const { html, text } = renderAutoTopUpSuccessTemplate(data);
    const messages = getEmailMessages(data.locale);

    return this.send({
      to: data.email,
      subject: messages.autoTopUpSuccess.subject,
      html,
      text,
    });
  }

  /**
   * Sends an auto top-up disabled notification email.
   *
   * @param data - Auto top-up disabled email data.
   * @returns True if sent successfully.
   */
  async sendAutoTopUpDisabledEmail(data: AutoTopUpDisabledEmailData): Promise<boolean> {
    const { renderAutoTopUpDisabledTemplate } = await import("../email/utils/template-renderer");
    const { html, text } = renderAutoTopUpDisabledTemplate(data);
    const messages = getEmailMessages(data.locale);

    return this.send({
      to: data.email,
      subject: messages.autoTopUpDisabled.subject,
      html,
      text,
    });
  }

  /**
   * Sends a purchase confirmation email.
   *
   * @param data - Purchase confirmation email data.
   * @returns True if sent successfully.
   */
  async sendPurchaseConfirmationEmail(data: PurchaseConfirmationEmailData): Promise<boolean> {
    const { renderPurchaseConfirmationTemplate } = await import("../email/utils/template-renderer");
    const { html, text } = renderPurchaseConfirmationTemplate(data);
    const messages = getEmailMessages(data.locale);

    return this.send({
      to: data.email,
      subject: messages.purchaseConfirmation.subject,
      html,
      text,
    });
  }

  /**
   * Sends a container shutdown warning email (48 hour notice).
   *
   * @param data - Container shutdown warning email data.
   * @returns True if sent successfully.
   */
  async sendContainerShutdownWarningEmail(
    data: ContainerShutdownWarningEmailData,
  ): Promise<boolean> {
    const { renderContainerShutdownWarningTemplate } = await import(
      "../email/utils/template-renderer"
    );
    const { html, text } = renderContainerShutdownWarningTemplate(data);
    const messages = getEmailMessages(data.locale);

    return this.send({
      to: data.email,
      subject: interpolateMessage(messages.containerShutdownWarning.subject, {
        containerName: data.containerName,
      }),
      html,
      text,
    });
  }
}

export const emailService = new EmailService();
