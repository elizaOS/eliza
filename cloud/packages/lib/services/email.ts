/**
 * Email service for sending transactional emails via SendGrid or SMTP.
 */

import sgMail from "@sendgrid/mail";
import type { Transporter } from "nodemailer";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import type {
  AutoTopUpDisabledEmailData,
  AutoTopUpSuccessEmailData,
  ContainerShutdownWarningEmailData,
  EmailOptions,
  InviteEmailData,
  LowCreditsEmailData,
  PurchaseConfirmationEmailData,
  WelcomeEmailData,
} from "@/lib/email/types";
import { logger } from "@/lib/utils/logger";

/**
 * Email service supporting SendGrid API and SMTP.
 */
class EmailService {
  private initialized = false;
  private fromEmail: string | null = null;
  private smtpTransporter: Transporter<SMTPTransport.SentMessageInfo> | null = null;
  private useSmtp = false;

  private initialize(): void {
    if (this.initialized) return;

    this.fromEmail =
      process.env.SENDGRID_FROM_EMAIL || process.env.SMTP_FROM || "noreply@elizacloud.ai";

    if (process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_PASSWORD) {
      logger.info("[EmailService] Using SMTP configuration");
      this.smtpTransporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT),
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
   * Sends an email using the configured provider (SendGrid or SMTP).
   *
   * @param options - Email options including recipient, subject, and content.
   * @returns True if sent successfully, false otherwise.
   */
  async send(options: EmailOptions): Promise<boolean> {
    this.initialize();

    if (!this.initialized) {
      logger.warn("[EmailService] Not initialized, skipping email send");
      return false;
    }

    if (this.useSmtp && this.smtpTransporter) {
      await this.smtpTransporter.sendMail({
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

      logger.info("[EmailService] Email sent via SMTP", {
        to: options.to,
        subject: options.subject,
      });

      return true;
    } else {
      const msg = {
        to: options.to,
        from: options.from || this.fromEmail!,
        subject: options.subject,
        text: options.text,
        html: options.html,
        replyTo: options.replyTo,
        attachments: options.attachments,
      };

      await sgMail.send(msg);

      logger.info("[EmailService] Email sent via API", {
        to: options.to,
        subject: options.subject,
      });

      return true;
    }
  }

  /**
   * Sends a welcome email to new users.
   *
   * @param data - Welcome email data.
   * @returns True if sent successfully.
   */
  async sendWelcomeEmail(data: WelcomeEmailData): Promise<boolean> {
    const { renderWelcomeTemplate } = await import("@/lib/email/utils/template-renderer");
    const { html, text } = renderWelcomeTemplate(data);

    return this.send({
      to: data.email,
      subject: "🎉 Welcome to Eliza Cloud - Let's Get Started!",
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
    const { renderLowCreditsTemplate } = await import("@/lib/email/utils/template-renderer");
    const { html, text } = renderLowCreditsTemplate(data);

    return this.send({
      to: data.email,
      subject: "⚠️ Low Credits Alert - Action Required",
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
    const { renderInviteTemplate } = await import("@/lib/email/utils/template-renderer");
    const { html, text } = renderInviteTemplate(data);

    return this.send({
      to: data.email,
      subject: `🎉 You've been invited to join ${data.organizationName} on Eliza Cloud`,
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
    const { renderAutoTopUpSuccessTemplate } = await import("@/lib/email/utils/template-renderer");
    const { html, text } = renderAutoTopUpSuccessTemplate(data);

    return this.send({
      to: data.email,
      subject: "✓ Auto Top-Up Successful - Balance Recharged",
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
    const { renderAutoTopUpDisabledTemplate } = await import("@/lib/email/utils/template-renderer");
    const { html, text } = renderAutoTopUpDisabledTemplate(data);

    return this.send({
      to: data.email,
      subject: "⚠ Auto Top-Up Disabled - Action Required",
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
    const { renderPurchaseConfirmationTemplate } = await import(
      "@/lib/email/utils/template-renderer"
    );
    const { html, text } = renderPurchaseConfirmationTemplate(data);

    return this.send({
      to: data.email,
      subject: "✓ Purchase Confirmed - Credits Added to Your Account",
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
      "@/lib/email/utils/template-renderer"
    );
    const { html, text } = renderContainerShutdownWarningTemplate(data);

    return this.send({
      to: data.email,
      subject: `🚨 URGENT: Container "${data.containerName}" will be shut down in 48 hours`,
      html,
      text,
    });
  }
}

export const emailService = new EmailService();
