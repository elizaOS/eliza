/**
 * Email template rendering utilities.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getEmailMessages, interpolateMessage } from "../messages";
import type {
  AutoTopUpDisabledEmailData,
  AutoTopUpSuccessEmailData,
  ContainerShutdownWarningEmailData,
  InviteEmailData,
  LowCreditsEmailData,
  PurchaseConfirmationEmailData,
  WelcomeEmailData,
} from "../types";

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
  const messages = getEmailMessages(data.locale);
  const m = messages.autoTopUpSuccess;
  const currentYear = new Date().getFullYear();
  const vars = {
    organizationName: data.organizationName,
    amount: data.amount.toFixed(2),
    previousBalance: data.previousBalance.toFixed(2),
    newBalance: data.newBalance.toFixed(2),
    paymentMethod: data.paymentMethod,
    year: currentYear,
  };

  const greeting = interpolateMessage(m.greeting, vars);
  const bodyHtml = interpolateMessage(m.body, vars);
  const bodyText = interpolateMessage(m.bodyText, vars);
  const footer = interpolateMessage(messages.footer.copyright, vars);

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${m.heading}</title>
</head>
<body style="font-family: monospace; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
  <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
    <h2 style="color: #FF5800; margin-top: 0;">${m.heading}</h2>
    <p style="color: #333; line-height: 1.6;">${greeting}</p>
    <p style="color: #333; line-height: 1.6;">${bodyHtml}</p>

    <div style="background-color: #f9f9f9; padding: 20px; border-radius: 6px; margin: 20px 0;">
      <h3 style="color: #333; margin-top: 0; font-size: 16px;">${m.detailsTitle}</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr style="border-bottom: 1px solid #ddd;">
          <td style="padding: 10px 0; color: #666;"><strong>${m.previousBalanceLabel}</strong></td>
          <td style="text-align: right; padding: 10px 0; color: #333;">$${vars.previousBalance}</td>
        </tr>
        <tr style="border-bottom: 1px solid #ddd;">
          <td style="padding: 10px 0; color: #666;"><strong>${m.amountAddedLabel}</strong></td>
          <td style="text-align: right; padding: 10px 0; color: #FF5800; font-weight: bold;">+$${vars.amount}</td>
        </tr>
        <tr style="border-bottom: 1px solid #ddd;">
          <td style="padding: 10px 0; color: #666;"><strong>${m.newBalanceLabel}</strong></td>
          <td style="text-align: right; padding: 10px 0; color: #333; font-weight: bold; font-size: 18px;">$${vars.newBalance}</td>
        </tr>
        <tr>
          <td style="padding: 10px 0; color: #666;"><strong>${m.paymentMethodLabel}</strong></td>
          <td style="text-align: right; padding: 10px 0; color: #333;">${vars.paymentMethod}</td>
        </tr>
      </table>
    </div>

    <p style="color: #666; font-size: 14px; line-height: 1.6; margin-top: 30px;">
      ${m.note}
    </p>

    <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">

    <p style="color: #999; font-size: 12px; text-align: center; margin-bottom: 0;">
      ${footer}
    </p>
  </div>
</body>
</html>`;

  const text = `
${m.heading}

${greeting}

${bodyText}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${m.detailsTitleText}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${m.previousBalanceLabel}    $${vars.previousBalance}
${m.amountAddedLabel}        +$${vars.amount}
${m.newBalanceLabel}         $${vars.newBalance}
${m.paymentMethodLabel}      ${vars.paymentMethod}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${m.note}

${footer}`;

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
  const messages = getEmailMessages(data.locale);
  const m = messages.autoTopUpDisabled;
  const currentYear = new Date().getFullYear();
  const vars = {
    organizationName: data.organizationName,
    reason: data.reason,
    currentBalance: data.currentBalance.toFixed(2),
    settingsUrl: data.settingsUrl,
    year: currentYear,
  };

  const greeting = interpolateMessage(m.greeting, vars);
  const footer = interpolateMessage(messages.footer.copyright, vars);

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${m.heading}</title>
</head>
<body style="font-family: monospace; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
  <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
    <h2 style="color: #dc2626; margin-top: 0;">${m.heading}</h2>
    <p style="color: #333; line-height: 1.6;">${greeting}</p>
    <p style="color: #333; line-height: 1.6;">${m.body}</p>

    <div style="background-color: #fef2f2; padding: 20px; border-radius: 6px; margin: 20px 0; border-left: 4px solid #dc2626;">
      <p style="margin: 0; color: #333;"><strong>${m.reasonLabel}</strong> ${vars.reason}</p>
      <p style="margin: 10px 0 0 0; color: #333;"><strong>${m.currentBalanceLabel}</strong> $${vars.currentBalance}</p>
    </div>

    <h3 style="color: #333; font-size: 16px; margin-top: 30px;">${m.whatToDo}</h3>
    <ol style="color: #666; line-height: 1.8; padding-left: 20px;">
      <li>${m.step1}</li>
      <li>${m.step2}</li>
      <li>${m.step3}</li>
    </ol>

    <p style="color: #666; font-size: 14px; line-height: 1.6; margin-top: 30px;">
      ${m.note}
    </p>

    <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">

    <p style="color: #999; font-size: 12px; text-align: center; margin-bottom: 0;">
      ${footer}
    </p>
  </div>
</body>
</html>`;

  const text = `
${m.heading}

${greeting}

${m.body}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${m.detailsTitleText}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${m.reasonLabel}              ${vars.reason}
${m.currentBalanceLabel}     $${vars.currentBalance}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${m.whatToDo}

1. ${m.step1}
2. ${m.step2}
3. ${m.step3}

${m.note}

${footer}`;

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
