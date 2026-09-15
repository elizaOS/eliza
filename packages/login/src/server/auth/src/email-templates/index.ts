import {
  type MagicLinkTemplateData,
  type OtpTemplateData,
  type RenderedMagicLinkTemplate,
  renderDefaultOtpTemplate,
  renderDefaultTemplate,
} from "./default";

export type { CustomEmailTemplate, TenantEmailTemplates } from "./custom";
export {
  magicLinkTemplateValues,
  otpTemplateValues,
  renderCustomTemplate,
} from "./custom";
export type {
  MagicLinkTemplateData,
  OtpTemplateData,
  RenderedMagicLinkTemplate,
} from "./default";

export function renderTemplate(
  templateId: string | undefined,
  data: MagicLinkTemplateData,
): RenderedMagicLinkTemplate {
  return renderDefaultTemplate(data);
}

/**
 * Per-tenant OTP (sign-in code) template resolution. Unknown/absent
 * templateIds fall back to the elizaOS-branded default so existing tenants
 * are unaffected.
 */
export function renderOtpTemplate(
  templateId: string | undefined,
  data: OtpTemplateData,
): RenderedMagicLinkTemplate {
  return renderDefaultOtpTemplate(data);
}
