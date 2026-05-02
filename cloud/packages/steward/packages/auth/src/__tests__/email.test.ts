import { describe, expect, it, mock } from "bun:test";

import { EmailAuth } from "../email";
import type { EmailProvider } from "../email-provider";

describe("EmailAuth.sendMagicLink", () => {
  it("calls the template renderer with the agreed magic-link payload", async () => {
    const sent = mock(async () => undefined);
    const templateRenderer = mock(() => ({
      subject: "subject",
      text: "text",
      html: "<p>html</p>",
    }));
    const provider: EmailProvider = { send: sent };
    const auth = new EmailAuth({
      from: "login@steward.fi",
      baseUrl: "https://steward.fi",
      provider,
      templateId: "elizacloud",
      tokenTtlMs: 10 * 60 * 1000,
      templateRenderer,
    });

    await auth.sendMagicLink("user@example.com");

    expect(templateRenderer).toHaveBeenCalledTimes(1);
    const [templateId, data] = templateRenderer.mock.calls[0]!;
    expect(templateId).toBe("elizacloud");
    expect(data).toMatchObject({
      email: "user@example.com",
      expiresInMinutes: 10,
      tenantName: undefined,
    });
    expect(data.magicLink).toContain("https://steward.fi/auth/callback/email?");
    expect(data.magicLink).toContain("email=user%40example.com");

    expect(sent).toHaveBeenCalledTimes(1);

    auth.destroy();
  });
});
