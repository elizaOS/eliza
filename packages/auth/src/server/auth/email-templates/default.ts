/** Renders escaped login email content using the tenant brand or the elizaOS default. */
export interface MagicLinkTemplateData {
  email: string;
  magicLink: string;
  code?: string;
  tenantName?: string;
  expiresInMinutes: number;
}

export interface OtpTemplateData {
  email: string;
  code: string;
  /** Display brand for the sending tenant (e.g. "elizaOS", "Acme"). */
  brandName: string;
  expiresInMinutes: number;
}

export interface RenderedMagicLinkTemplate {
  subject: string;
  text: string;
  html: string;
}

export function escapeEmailHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderDefaultTemplate({
  magicLink,
  code,
  tenantName,
  expiresInMinutes,
}: MagicLinkTemplateData): RenderedMagicLinkTemplate {
  const brandName = tenantName?.trim() || "elizaOS";
  const escapedBrand = escapeEmailHtml(brandName);
  const footer = brandName === "elizaOS" ? "eliza.app — elizaOS" : escapedBrand;
  const codeText = code
    ? [
        "Or enter this 6-digit code from the same email challenge:",
        "",
        code,
        "",
        "The link or code can be used once.",
        "",
      ]
    : [];
  const codeHtml = code
    ? `<table width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="font-size:13px;color:#6b6560;line-height:1.5;padding-bottom:12px;text-align:center;">
              Or enter this 6-digit code:
            </td></tr>
            <tr><td align="center" style="padding-bottom:32px;">
              <span style="display:inline-block;background-color:#0b0a09;border:1px solid #2a2722;color:#e8e5e0;font-size:30px;font-weight:700;letter-spacing:0.3em;padding:14px 18px 14px 26px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${code}</span>
            </td></tr>
          </table>`
    : "";
  return {
    subject: `Sign in to ${brandName}`,
    text: [
      "Click the link below to sign in:",
      "",
      magicLink,
      "",
      ...codeText,
      `This sign-in email expires in ${expiresInMinutes} minutes.`,
      "If you didn't request this, you can safely ignore this email.",
      "",
      `— ${brandName}`,
    ].join("\n"),
    html: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#0b0a09;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#0b0a09;min-height:100vh;">
    <tr><td align="center" style="padding:60px 24px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:420px;">
        <tr><td align="center" style="padding-bottom:40px;">
          <table cellpadding="0" cellspacing="0"><tr>
            <td style="font-size:20px;font-weight:700;color:#e8e5e0;letter-spacing:-0.02em;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
              ✦&nbsp;&nbsp;${escapedBrand}
            </td>
          </tr></table>
        </td></tr>
        <tr><td style="background-color:#141210;border:1px solid #2a2722;padding:40px 32px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="font-size:22px;font-weight:700;color:#e8e5e0;letter-spacing:-0.02em;padding-bottom:8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
              Sign in to ${escapedBrand}
            </td></tr>
            <tr><td style="font-size:14px;color:#6b6560;line-height:1.5;padding-bottom:32px;">
              Click the button below to securely sign in, or enter the code. This email expires in ${expiresInMinutes} minutes.
            </td></tr>
          </table>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td align="center" style="padding-bottom:32px;">
              <a href="${magicLink}" target="_blank" style="display:inline-block;background-color:#c4873a;color:#0b0a09;font-size:14px;font-weight:600;text-decoration:none;padding:12px 32px;letter-spacing:0.01em;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
                Sign in
              </a>
            </td></tr>
          </table>
          ${codeHtml}
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="border-top:1px solid #2a2722;padding-top:24px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr><td style="font-size:11px;color:#6b6560;line-height:1.6;">
                  Or copy this link into your browser:
                </td></tr>
                <tr><td style="font-size:11px;color:#9c9788;word-break:break-all;line-height:1.5;padding-top:6px;">
                  ${magicLink}
                </td></tr>
              </table>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding-top:24px;text-align:center;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="font-size:11px;color:#6b6560;line-height:1.6;">
              If you didn't request this email, you can safely ignore it.
            </td></tr>
            <tr><td style="font-size:11px;color:#4a4540;padding-top:12px;">
              ${footer}
            </td></tr>
          </table>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  };
}

/**
 * Default (elizaOS-branded) OTP sign-in-code email.
 *
 * OTP emails use the same per-tenant template contract as magic-link emails.
 */
export function renderDefaultOtpTemplate({
  code,
  brandName,
  expiresInMinutes,
}: OtpTemplateData): RenderedMagicLinkTemplate {
  const escapedBrand = escapeEmailHtml(brandName);
  const escapedCode = escapeEmailHtml(code);
  return {
    subject: `${code} is your ${brandName} sign-in code`,
    text: [
      `Your ${brandName} sign-in code is: ${code}`,
      "",
      `It expires in ${expiresInMinutes} minutes. If you didn't request this, ignore this email.`,
    ].join("\n"),
    html: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#0b0a09;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#0b0a09;min-height:100vh;">
    <tr><td align="center" style="padding:60px 24px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:420px;">
        <tr><td style="background-color:#141210;border:1px solid #2a2722;padding:40px 32px;">
          <div style="font-size:18px;font-weight:700;color:#e8e5e0;padding-bottom:8px;">${escapedBrand} sign-in code</div>
          <div style="font-size:13px;color:#9c9788;line-height:1.5;padding-bottom:24px;">Enter this code to verify your email. It expires in ${expiresInMinutes} minutes.</div>
          <div style="text-align:center;padding-bottom:24px;">
            <span style="display:inline-block;background-color:#0b0a09;border:1px solid #2a2722;color:#e8e5e0;font-size:32px;font-weight:700;letter-spacing:0.35em;padding:16px 24px 16px 32px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${escapedCode}</span>
          </div>
          <div style="border-top:1px solid #2a2722;padding-top:20px;font-size:11px;color:#9c9788;line-height:1.5;">If you didn't request this code, you can safely ignore this email.</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  };
}
