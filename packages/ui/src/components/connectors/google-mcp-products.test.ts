/**
 * Verifies the deterministic personal Google product-to-capability and OAuth
 * scope mapping used by local and Cloud connector forms.
 */

import { describe, expect, it } from "vitest";
import {
  capabilitiesForPersonalGoogleProducts,
  oauthScopesForPersonalGoogleProducts,
  PERSONAL_GOOGLE_MCP_PRODUCTS,
} from "./google-mcp-products";

describe("personal Google MCP product catalog", () => {
  it("models Gmail as read, manage, and draft-only", () => {
    const gmail = PERSONAL_GOOGLE_MCP_PRODUCTS.find(
      (product) => product.id === "gmail",
    );
    expect(gmail?.capabilities).toEqual([
      "gmail.read",
      "gmail.draft",
      "gmail.manage",
    ]);
    expect(gmail?.description.toLowerCase()).toContain("draft");
    expect(gmail?.description.toLowerCase()).toContain("not available");
    expect(JSON.stringify(gmail)).not.toContain("gmail.send");
  });

  it("deduplicates capabilities and uses narrow product scopes", () => {
    expect(
      capabilitiesForPersonalGoogleProducts(["gmail", "calendar"]),
    ).toEqual(["gmail.read", "gmail.draft", "gmail.manage", "calendar.read"]);
    const scopes = oauthScopesForPersonalGoogleProducts([
      "gmail",
      "universalSearch",
    ]);
    expect(scopes).toContain("https://www.googleapis.com/auth/gmail.compose");
    expect(scopes).not.toContain("https://www.googleapis.com/auth/gmail.send");
    expect(scopes).not.toContain("https://mail.google.com/");
    expect(new Set(scopes).size).toBe(scopes.length);
  });
});
