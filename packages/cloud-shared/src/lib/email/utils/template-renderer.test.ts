/**
 * Regression test for the email template renderer. The templates used to load
 * from disk via fs.readFileSync + fileURLToPath(import.meta.url), which throws
 * in the Cloudflare Workers runtime ("path argument must be of type string ...
 * Received undefined") — so every billed-inference low-credits email silently
 * failed. Templates are now bundled as strings; assert they render + interpolate.
 */
import { describe, expect, test } from "bun:test";

import { EMAIL_TEMPLATES } from "./email-templates.generated";
import { renderLowCreditsTemplate, renderWelcomeTemplate } from "./template-renderer";

describe("email template renderer", () => {
  test("renders the low-credits email with interpolated data (no fs access)", () => {
    const { html, text } = renderLowCreditsTemplate({
      email: "ops@example.com",
      organizationName: "Acme Robotics",
      currentBalance: 1.23,
      threshold: 5,
      billingUrl: "https://cloud.example/dashboard/billing",
    });

    expect(html.length).toBeGreaterThan(0);
    expect(text.length).toBeGreaterThan(0);
    expect(html).toContain("Acme Robotics");
    expect(text).toContain("Acme Robotics");
    // The {{...}} placeholders must all be interpolated away.
    expect(html).not.toContain("{{organizationName}}");
    expect(text).not.toContain("{{billingUrl}}");
  });

  test("renders the welcome email (bundled template, no fs access)", () => {
    const { html, text } = renderWelcomeTemplate({
      email: "user@example.com",
      userName: "Ada",
      organizationName: "Acme Robotics",
      creditBalance: 100,
      dashboardUrl: "https://cloud.example/dashboard",
    });

    expect(html.length).toBeGreaterThan(0);
    expect(text.length).toBeGreaterThan(0);
    expect(html).toContain("Welcome to Cloud");
    // No un-interpolated placeholders leak through.
    expect(html).not.toMatch(/\{\{\w+\}\}/);
  });

  test("every template id resolves to a non-empty bundled string", () => {
    for (const [name, body] of Object.entries(EMAIL_TEMPLATES)) {
      expect(body.length, `${name} is non-empty`).toBeGreaterThan(0);
    }
    expect(Object.keys(EMAIL_TEMPLATES)).toContain("low-credits.html");
    expect(Object.keys(EMAIL_TEMPLATES)).toContain("welcome.txt");
  });
});
