import type { MagicLinkTemplateData, RenderedMagicLinkTemplate } from "./default";

/**
 * Eliza Cloud magic link template.
 *
 * Brand: dark cyberpunk, green accent (#00ff87), mono wordmark.
 * Designed for tenants using templateId: "elizacloud".
 */
export function renderElizaCloudTemplate({
  magicLink,
  expiresInMinutes,
}: MagicLinkTemplateData): RenderedMagicLinkTemplate {
  const mono = "'JetBrains Mono', 'Menlo', 'Consolas', 'Courier New', monospace";
  const sans =
    "'Space Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

  return {
    subject: "access granted, eliza cloud",
    text: [
      "eliza cloud",
      "───────────",
      "",
      "you asked to sign in. tap the link below.",
      "",
      magicLink,
      "",
      `expires in ${expiresInMinutes} minutes. single use.`,
      "",
      "if this wasn't you, ignore this email. nothing happens until you click.",
      "",
      "eliza cloud",
    ].join("\n"),
    html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="dark" />
  <meta name="supported-color-schemes" content="dark" />
  <title>access granted, eliza cloud</title>
</head>
<body style="margin:0;padding:0;background-color:#0a0a0a;color:#e6e6e6;font-family:${sans};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#0a0a0a;font-size:1px;line-height:1px;">
    you asked to sign in. link expires in ${expiresInMinutes} minutes.
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0a0a0a;">
    <tr>
      <td align="center" style="padding:48px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#0a0a0a;">

          <tr>
            <td style="padding:0 0 32px 0;font-family:${mono};font-size:13px;letter-spacing:0.18em;color:#7a7a7a;text-transform:uppercase;">
              <span style="color:#00ff87;">&#x258D;</span>&nbsp;eliza cloud
            </td>
          </tr>

          <tr>
            <td style="padding:0 0 8px 0;font-family:${sans};font-size:28px;line-height:1.2;color:#e6e6e6;font-weight:600;letter-spacing:-0.01em;">
              access granted.
            </td>
          </tr>

          <tr>
            <td style="padding:0 0 32px 0;font-family:${sans};font-size:15px;line-height:1.6;color:#7a7a7a;">
              you asked to sign in. tap the link below and we'll put you back where you were.
            </td>
          </tr>

          <tr>
            <td style="padding:0 0 24px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" bgcolor="#00ff87" style="border-radius:2px;background-color:#00ff87;">
                    <a href="${magicLink}"
                       style="display:inline-block;padding:16px 32px;font-family:${mono};font-size:14px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#001b0e;text-decoration:none;border-radius:2px;">
                      sign in &rarr;
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:0 0 32px 0;font-family:${sans};font-size:13px;line-height:1.6;color:#7a7a7a;">
              or paste this into your browser:<br />
              <a href="${magicLink}" style="color:#00ff87;text-decoration:none;font-family:${mono};font-size:12px;word-break:break-all;">${magicLink}</a>
            </td>
          </tr>

          <tr>
            <td style="padding:0 0 24px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="height:1px;background-color:#222222;line-height:1px;font-size:1px;">&nbsp;</td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:0 0 32px 0;font-family:${mono};font-size:12px;line-height:1.8;color:#4a4a4a;">
              <span style="color:#7a7a7a;">expires</span>&nbsp;&nbsp;${expiresInMinutes} minutes<br />
              <span style="color:#7a7a7a;">usage</span>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;single use
            </td>
          </tr>

          <tr>
            <td style="padding:0 0 16px 0;font-family:${sans};font-size:12px;line-height:1.6;color:#4a4a4a;">
              if this wasn't you, ignore this email. nothing happens until you click.
            </td>
          </tr>

          <tr>
            <td style="padding:16px 0 0 0;font-family:${mono};font-size:12px;letter-spacing:0.1em;color:#7a7a7a;border-top:1px solid #222222;">
              <span style="color:#00ff87;">&#x258D;</span>&nbsp;eliza cloud
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
  };
}
