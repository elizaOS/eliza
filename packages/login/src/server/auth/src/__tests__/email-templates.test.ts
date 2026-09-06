import { describe, expect, it } from "bun:test";

import {
  magicLinkTemplateValues,
  otpTemplateValues,
  renderCustomTemplate,
} from "../email-templates/custom";
import {
  renderDefaultOtpTemplate,
  renderDefaultTemplate,
} from "../email-templates/default";
import { renderOtpTemplate, renderTemplate } from "../email-templates/index";

const MAGIC_LINK_DATA = {
  email: "user@example.com",
  magicLink: "https://steward.fi/auth/callback/email?token=test",
  expiresInMinutes: 10,
};

const OTP_DATA = {
  email: "user@example.com",
  code: "123456",
  brandName: "elizaOS",
  expiresInMinutes: 10,
};

describe("renderTemplate", () => {
  it("falls back to the default template for unknown template ids", () => {
    expect(renderTemplate("unknown-template", MAGIC_LINK_DATA)).toEqual(
      renderDefaultTemplate(MAGIC_LINK_DATA),
    );
  });

  it("does not ship tenant-specific branded templates in OSS", () => {
    expect(renderTemplate("customer-template", MAGIC_LINK_DATA)).toEqual(
      renderDefaultTemplate(MAGIC_LINK_DATA),
    );
  });
});

describe("default magic-link template", () => {
  it("uses and HTML-escapes the configured tenant brand", () => {
    const rendered = renderDefaultTemplate({
      ...MAGIC_LINK_DATA,
      tenantName: '<b>Customer "Cloud"</b>',
    });

    expect(rendered.subject).toBe('Sign in to <b>Customer "Cloud"</b>');
    expect(rendered.text).toContain('— <b>Customer "Cloud"</b>');
    expect(rendered.html).toContain(
      "&lt;b&gt;Customer &quot;Cloud&quot;&lt;/b&gt;",
    );
    expect(rendered.html).not.toContain('<b>Customer "Cloud"</b>');
    expect(rendered.html).not.toContain("agent wallet infrastructure");
  });
});

describe("renderOtpTemplate", () => {
  it("falls back to the default OTP template for unknown/absent template ids", () => {
    expect(renderOtpTemplate(undefined, OTP_DATA)).toEqual(
      renderDefaultOtpTemplate(OTP_DATA),
    );
    expect(renderOtpTemplate("unknown-template", OTP_DATA)).toEqual(
      renderDefaultOtpTemplate(OTP_DATA),
    );
  });
});

describe("default OTP template", () => {
  it("escapes untrusted tenant branding in the rendered email", () => {
    const rendered = renderDefaultOtpTemplate({
      ...OTP_DATA,
      brandName: '<b>"Evil"</b>',
    });

    expect(rendered.subject).toBe('123456 is your <b>"Evil"</b> sign-in code');
    expect(rendered.html).toContain(
      "&lt;b&gt;&quot;Evil&quot;&lt;/b&gt; sign-in code",
    );
    expect(rendered.html).not.toContain('<b>"Evil"</b>');
    expect(rendered.html).toContain("123456");
    expect(rendered.text).toContain("It expires in 10 minutes.");
  });
});

describe("renderCustomTemplate (deployer-supplied raw templates)", () => {
  const template = {
    subject: "Sign in to {{tenantName}}",
    text: "Link: {{magicLink}} (expires in {{expiresInMinutes}} minutes)",
    html: '<a href="{{magicLink}}">Sign in</a> sent to {{email}}',
  };

  it("substitutes magic-link placeholders", () => {
    const rendered = renderCustomTemplate(
      template,
      magicLinkTemplateValues({ ...MAGIC_LINK_DATA, tenantName: "Acme" }),
    );
    expect(rendered.subject).toBe("Sign in to Acme");
    expect(rendered.text).toContain(MAGIC_LINK_DATA.magicLink);
    expect(rendered.text).toContain("expires in 10 minutes");
    expect(rendered.html).toContain("user@example.com");
  });

  it("HTML-escapes substituted values in the html body only", () => {
    const rendered = renderCustomTemplate(
      { subject: "{{email}}", text: "{{email}}", html: "<p>{{email}}</p>" },
      magicLinkTemplateValues({
        ...MAGIC_LINK_DATA,
        email: '<script>alert(1)</script>"@example.com',
      }),
    );
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).toContain("&lt;script&gt;");
    // subject/text are not HTML contexts — inserted verbatim
    expect(rendered.subject).toContain("<script>");
  });

  it("leaves unknown placeholders untouched so typos fail loudly", () => {
    const rendered = renderCustomTemplate(
      { subject: "x", text: "{{tyop}}", html: "{{tyop}}" },
      magicLinkTemplateValues(MAGIC_LINK_DATA),
    );
    expect(rendered.text).toBe("{{tyop}}");
    expect(rendered.html).toBe("{{tyop}}");
  });

  it("substitutes OTP placeholders", () => {
    const rendered = renderCustomTemplate(
      {
        subject: "{{code}} is your {{brandName}} code",
        text: "Code: {{code}}",
        html: "<b>{{code}}</b>",
      },
      otpTemplateValues(OTP_DATA),
    );
    expect(rendered.subject).toBe("123456 is your elizaOS code");
    expect(rendered.html).toBe("<b>123456</b>");
  });
});

describe("magic-link companion code templates", () => {
  const data = { ...MAGIC_LINK_DATA, code: "123456" };

  it("renders the code in default text and html", () => {
    const rendered = renderDefaultTemplate(data);
    expect(rendered.text).toContain("123456");
    expect(rendered.html).toContain("123456");
    expect(rendered.text).toContain(data.magicLink);
    expect(rendered.html).toContain(data.magicLink);
  });

  it("exposes the code to deployer-supplied magic-link templates via {{code}}", () => {
    const rendered = renderCustomTemplate(
      {
        subject: "Sign in",
        text: "Link: {{magicLink}} Code: {{code}}",
        html: '<a href="{{magicLink}}">Sign in</a> or enter <b>{{code}}</b>',
      },
      magicLinkTemplateValues(data),
    );
    expect(rendered.text).toContain("123456");
    expect(rendered.html).toContain("<b>123456</b>");
    expect(rendered.text).toContain(data.magicLink);
  });

  it("substitutes an empty string for {{code}} when no companion code was issued", () => {
    const rendered = renderCustomTemplate(
      { subject: "Sign in", text: "Code: {{code}}", html: "<b>{{code}}</b>" },
      magicLinkTemplateValues(MAGIC_LINK_DATA),
    );
    expect(rendered.text).toBe("Code: ");
    expect(rendered.html).toBe("<b></b>");
  });
});
