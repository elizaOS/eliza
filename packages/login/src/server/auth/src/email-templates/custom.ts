import type {
  MagicLinkTemplateData,
  OtpTemplateData,
  RenderedMagicLinkTemplate,
} from "./default";
import { escapeEmailHtml } from "./default";

/**
 * Deployer-supplied raw email template (subject + text + html) with
 * `{{placeholder}}` substitution. This is the vendor-neutral mechanism for
 * per-tenant branded auth emails: the OSS repo ships only the substitution
 * engine, while the actual branded markup lives in the deployer's own
 * instance as tenant configuration (tenant_configs.email_config.templates),
 * never in this repository.
 *
 * Placeholders (magic link): {{magicLink}}, {{code}}, {{email}},
 * {{tenantName}}, {{expiresInMinutes}}. ({{code}} is the six-digit companion
 * code that shares the magic-link challenge; empty when no code was issued.)
 * Placeholders (OTP): {{code}}, {{email}}, {{brandName}}, {{expiresInMinutes}}.
 *
 * Substituted values are HTML-escaped in the `html` body (the template markup
 * itself is trusted platform-admin config; the runtime values are not),
 * and inserted verbatim in `subject`/`text`. Unknown placeholders are left
 * untouched so typos fail loudly in rendered output instead of silently
 * dropping content.
 */
export interface CustomEmailTemplate {
  subject: string;
  text: string;
  html: string;
}

export interface TenantEmailTemplates {
  magicLink?: CustomEmailTemplate;
  otp?: CustomEmailTemplate;
}

function substitute(
  template: string,
  values: Record<string, string>,
  escapeHtml: boolean,
): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
    const value = values[key];
    if (value === undefined) return match;
    return escapeHtml ? escapeEmailHtml(value) : value;
  });
}

export function renderCustomTemplate(
  template: CustomEmailTemplate,
  values: Record<string, string>,
): RenderedMagicLinkTemplate {
  return {
    subject: substitute(template.subject, values, false),
    text: substitute(template.text, values, false),
    html: substitute(template.html, values, true),
  };
}

export function magicLinkTemplateValues(
  data: MagicLinkTemplateData,
): Record<string, string> {
  return {
    magicLink: data.magicLink,
    code: data.code ?? "",
    email: data.email,
    tenantName: data.tenantName ?? "",
    expiresInMinutes: String(data.expiresInMinutes),
  };
}

export function otpTemplateValues(
  data: OtpTemplateData,
): Record<string, string> {
  return {
    code: data.code,
    email: data.email,
    brandName: data.brandName,
    expiresInMinutes: String(data.expiresInMinutes),
  };
}
