import { describe, expect, it } from "bun:test";

import { renderDefaultTemplate } from "../email-templates/default";
import { renderTemplate } from "../email-templates/index";

describe("renderTemplate", () => {
  it("falls back to the default template for unknown template ids", () => {
    const data = {
      email: "user@example.com",
      magicLink: "https://steward.fi/auth/callback/email?token=test",
      expiresInMinutes: 10,
    };

    expect(renderTemplate("unknown-template", data)).toEqual(renderDefaultTemplate(data));
  });
});
