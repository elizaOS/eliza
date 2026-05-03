export interface MagicLinkTemplateData {
  email: string;
  magicLink: string;
  tenantName?: string;
  expiresInMinutes: number;
}

export interface RenderedMagicLinkTemplate {
  subject: string;
  text: string;
  html: string;
}

export function renderDefaultTemplate({
  magicLink,
}: MagicLinkTemplateData): RenderedMagicLinkTemplate {
  return {
    subject: "Sign in to Steward",
    text: [
      "Click the link below to sign in:",
      "",
      magicLink,
      "",
      "This link expires in 10 minutes.",
      "If you didn't request this, you can safely ignore this email.",
      "",
      "— Steward",
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
              ✦&nbsp;&nbsp;steward
            </td>
          </tr></table>
        </td></tr>
        <tr><td style="background-color:#141210;border:1px solid #2a2722;padding:40px 32px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="font-size:22px;font-weight:700;color:#e8e5e0;letter-spacing:-0.02em;padding-bottom:8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
              Sign in to Steward
            </td></tr>
            <tr><td style="font-size:14px;color:#6b6560;line-height:1.5;padding-bottom:32px;">
              Click the button below to securely sign in. This link expires in 10 minutes.
            </td></tr>
          </table>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td align="center" style="padding-bottom:32px;">
              <a href="${magicLink}" target="_blank" style="display:inline-block;background-color:#c4873a;color:#0b0a09;font-size:14px;font-weight:600;text-decoration:none;padding:12px 32px;letter-spacing:0.01em;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
                Sign in
              </a>
            </td></tr>
          </table>
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
              steward.fi — agent wallet infrastructure
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
