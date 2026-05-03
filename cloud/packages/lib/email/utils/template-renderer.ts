/**
 * Email template rendering utilities.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type {
  AutoTopUpDisabledEmailData,
  AutoTopUpSuccessEmailData,
  ContainerShutdownWarningEmailData,
  InviteEmailData,
  LowCreditsEmailData,
  PurchaseConfirmationEmailData,
  WelcomeEmailData,
} from "@/lib/email/types";

/**
 * Loads an email template file from disk.
 *
 * @param filename - Template filename.
 * @returns Template content as string.
 */
function loadTemplate(filename: string): string {
  // Use path relative to this file (utils/ → ../templates/) for reliable resolution
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const templatePath = path.resolve(__dirname, "..", "templates", filename);
  return fs.readFileSync(templatePath, "utf-8");
}

/**
 * Interpolates template variables with data.
 *
 * @param template - Template string with {{variable}} placeholders.
 * @param data - Data object with values to interpolate.
 * @returns Interpolated template string.
 */
function interpolate(template: string, data: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return String(data[key] ?? match);
  });
}

/**
 * Renders the welcome email template.
 *
 * @param data - Welcome email data.
 * @returns Rendered HTML and text versions.
 */
export function renderWelcomeTemplate(data: WelcomeEmailData): {
  html: string;
  text: string;
} {
  const htmlTemplate = loadTemplate("welcome.html");
  const textTemplate = loadTemplate("welcome.txt");

  const baseUrl = data.dashboardUrl.replace(/\/dashboard.*/, "");
  const templateData = {
    userName: data.userName,
    organizationName: data.organizationName,
    creditBalance: data.creditBalance.toLocaleString(),
    dashboardUrl: data.dashboardUrl,
    docsUrl: `${baseUrl}/docs`,
    baseUrl: baseUrl,
    currentYear: new Date().getFullYear(),
  };

  return {
    html: interpolate(htmlTemplate, templateData),
    text: interpolate(textTemplate, templateData),
  };
}

/**
 * Renders the low credits warning email template.
 *
 * @param data - Low credits email data.
 * @returns Rendered HTML and text versions.
 */
export function renderLowCreditsTemplate(data: LowCreditsEmailData): {
  html: string;
  text: string;
} {
  const htmlTemplate = loadTemplate("low-credits.html");
  const textTemplate = loadTemplate("low-credits.txt");

  const templateData = {
    organizationName: data.organizationName,
    currentBalance: data.currentBalance.toLocaleString(),
    threshold: data.threshold.toLocaleString(),
    billingUrl: data.billingUrl,
    currentYear: new Date().getFullYear(),
  };

  return {
    html: interpolate(htmlTemplate, templateData),
    text: interpolate(textTemplate, templateData),
  };
}

/**
 * Renders the organization invite email template.
 *
 * @param data - Invite email data.
 * @returns Rendered HTML and text versions.
 */
export function renderInviteTemplate(data: InviteEmailData): {
  html: string;
  text: string;
} {
  const htmlTemplate = loadTemplate("invite.html");
  const textTemplate = loadTemplate("invite.txt");

  const acceptUrl = `${process.env.NEXT_PUBLIC_APP_URL}/invite/accept?token=${data.inviteToken}`;

  const templateData = {
    inviterName: data.inviterName,
    organizationName: data.organizationName,
    role: data.role,
    acceptUrl,
    currentYear: new Date().getFullYear(),
  };

  return {
    html: interpolate(htmlTemplate, templateData),
    text: interpolate(textTemplate, templateData),
  };
}

/**
 * Renders the auto top-up success email template.
 *
 * @param data - Auto top-up success email data.
 * @returns Rendered HTML and text versions.
 */
export function renderAutoTopUpSuccessTemplate(data: AutoTopUpSuccessEmailData): {
  html: string;
  text: string;
} {
  const templateData = {
    organizationName: data.organizationName,
    amount: data.amount.toFixed(2),
    previousBalance: data.previousBalance.toFixed(2),
    newBalance: data.newBalance.toFixed(2),
    paymentMethod: data.paymentMethod,
    invoiceUrl: data.invoiceUrl,
    billingUrl: data.billingUrl,
    currentYear: new Date().getFullYear(),
  };

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Auto Top-Up Successful</title>
</head>
<body style="font-family: monospace; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
  <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
    <h2 style="color: #FF5800; margin-top: 0;">✓ Auto Top-Up Successful</h2>
    <p style="color: #333; line-height: 1.6;">Hi ${templateData.organizationName} team,</p>
    <p style="color: #333; line-height: 1.6;">Your account has been automatically topped up with <strong>$${templateData.amount}</strong>.</p>

    <div style="background-color: #f9f9f9; padding: 20px; border-radius: 6px; margin: 20px 0;">
      <h3 style="color: #333; margin-top: 0; font-size: 16px;">Transaction Details</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr style="border-bottom: 1px solid #ddd;">
          <td style="padding: 10px 0; color: #666;"><strong>Previous Balance:</strong></td>
          <td style="text-align: right; padding: 10px 0; color: #333;">$${templateData.previousBalance}</td>
        </tr>
        <tr style="border-bottom: 1px solid #ddd;">
          <td style="padding: 10px 0; color: #666;"><strong>Amount Added:</strong></td>
          <td style="text-align: right; padding: 10px 0; color: #FF5800; font-weight: bold;">+$${templateData.amount}</td>
        </tr>
        <tr style="border-bottom: 1px solid #ddd;">
          <td style="padding: 10px 0; color: #666;"><strong>New Balance:</strong></td>
          <td style="text-align: right; padding: 10px 0; color: #333; font-weight: bold; font-size: 18px;">$${templateData.newBalance}</td>
        </tr>
        <tr>
          <td style="padding: 10px 0; color: #666;"><strong>Payment Method:</strong></td>
          <td style="text-align: right; padding: 10px 0; color: #333;">${templateData.paymentMethod}</td>
        </tr>
      </table>
    </div>

    <p style="color: #666; font-size: 14px; line-height: 1.6; margin-top: 30px;">
      This automatic top-up ensures your services continue running without interruption. You can manage your auto top-up settings in your dashboard.
    </p>

    <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">

    <p style="color: #999; font-size: 12px; text-align: center; margin-bottom: 0;">
      © ${templateData.currentYear} Eliza Cloud. All rights reserved.
    </p>
  </div>
</body>
</html>`;

  const text = `
✓ Auto Top-Up Successful

Hi ${templateData.organizationName} team,

Your account has been automatically topped up with $${templateData.amount}.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TRANSACTION DETAILS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Previous Balance:    $${templateData.previousBalance}
Amount Added:        +$${templateData.amount}
New Balance:         $${templateData.newBalance}
Payment Method:      ${templateData.paymentMethod}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

This automatic top-up ensures your services continue running without interruption. You can manage your auto top-up settings in your dashboard.

© ${templateData.currentYear} Eliza Cloud. All rights reserved.`;

  return { html, text };
}

/**
 * Renders the auto top-up disabled email template.
 *
 * @param data - Auto top-up disabled email data.
 * @returns Rendered HTML and text versions.
 */
export function renderAutoTopUpDisabledTemplate(data: AutoTopUpDisabledEmailData): {
  html: string;
  text: string;
} {
  const templateData = {
    organizationName: data.organizationName,
    reason: data.reason,
    currentBalance: data.currentBalance.toFixed(2),
    settingsUrl: data.settingsUrl,
    currentYear: new Date().getFullYear(),
  };

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Auto Top-Up Disabled</title>
</head>
<body style="font-family: monospace; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
  <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
    <h2 style="color: #dc2626; margin-top: 0;">⚠ Auto Top-Up Disabled</h2>
    <p style="color: #333; line-height: 1.6;">Hi ${templateData.organizationName} team,</p>
    <p style="color: #333; line-height: 1.6;">Your auto top-up feature has been automatically disabled.</p>

    <div style="background-color: #fef2f2; padding: 20px; border-radius: 6px; margin: 20px 0; border-left: 4px solid #dc2626;">
      <p style="margin: 0; color: #333;"><strong>Reason:</strong> ${templateData.reason}</p>
      <p style="margin: 10px 0 0 0; color: #333;"><strong>Current Balance:</strong> $${templateData.currentBalance}</p>
    </div>

    <h3 style="color: #333; font-size: 16px; margin-top: 30px;">What should you do?</h3>
    <ol style="color: #666; line-height: 1.8; padding-left: 20px;">
      <li>Log in to your dashboard and review your payment method settings</li>
      <li>Update your payment information if needed</li>
      <li>Re-enable auto top-up in your billing settings</li>
    </ol>

    <p style="color: #666; font-size: 14px; line-height: 1.6; margin-top: 30px;">
      To prevent service interruptions, please address this issue as soon as possible. Your current balance is displayed above.
    </p>

    <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">

    <p style="color: #999; font-size: 12px; text-align: center; margin-bottom: 0;">
      © ${templateData.currentYear} Eliza Cloud. All rights reserved.
    </p>
  </div>
</body>
</html>`;

  const text = `
⚠ Auto Top-Up Disabled

Hi ${templateData.organizationName} team,

Your auto top-up feature has been automatically disabled.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DETAILS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Reason:              ${templateData.reason}
Current Balance:     $${templateData.currentBalance}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

What should you do?

1. Log in to your dashboard and review your payment method settings
2. Update your payment information if needed
3. Re-enable auto top-up in your billing settings

To prevent service interruptions, please address this issue as soon as possible. Your current balance is displayed above.

© ${templateData.currentYear} Eliza Cloud. All rights reserved.`;

  return { html, text };
}

/**
 * Renders the purchase confirmation email template.
 *
 * @param data - Purchase confirmation email data.
 * @returns Rendered HTML and text versions.
 */
export function renderPurchaseConfirmationTemplate(data: PurchaseConfirmationEmailData): {
  html: string;
  text: string;
} {
  const htmlTemplate = loadTemplate("purchase-confirmation.html");
  const textTemplate = loadTemplate("purchase-confirmation.txt");

  const templateData = {
    organizationName: data.organizationName,
    purchaseAmount: data.purchaseAmount.toFixed(2),
    creditsAdded: data.creditsAdded.toFixed(2),
    previousBalance: data.previousBalance.toFixed(2),
    newBalance: data.newBalance.toFixed(2),
    paymentMethod: data.paymentMethod,
    transactionDate: data.transactionDate,
    invoiceNumber: data.invoiceNumber || "N/A",
    invoiceUrl: data.invoiceUrl || data.dashboardUrl,
    dashboardUrl: data.dashboardUrl,
    currentYear: new Date().getFullYear(),
  };

  return {
    html: interpolate(htmlTemplate, templateData),
    text: interpolate(textTemplate, templateData),
  };
}

/**
 * Renders the container shutdown warning email template.
 *
 * @param data - Container shutdown warning email data.
 * @returns Rendered HTML and text versions.
 */
export function renderContainerShutdownWarningTemplate(data: ContainerShutdownWarningEmailData): {
  html: string;
  text: string;
} {
  const htmlTemplate = loadTemplate("container-shutdown-warning.html");
  const textTemplate = loadTemplate("container-shutdown-warning.txt");

  const templateData = {
    organizationName: data.organizationName,
    containerName: data.containerName,
    projectName: data.projectName,
    dailyCost: data.dailyCost.toFixed(2),
    monthlyCost: data.monthlyCost.toFixed(2),
    currentBalance: data.currentBalance.toFixed(2),
    requiredCredits: data.requiredCredits.toFixed(2),
    minimumRecommended: data.minimumRecommended.toFixed(2),
    shutdownTime: data.shutdownTime,
    billingUrl: data.billingUrl,
    dashboardUrl: data.dashboardUrl,
    currentYear: new Date().getFullYear(),
  };

  return {
    html: interpolate(htmlTemplate, templateData),
    text: interpolate(textTemplate, templateData),
  };
}
