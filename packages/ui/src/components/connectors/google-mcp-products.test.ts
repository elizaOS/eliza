/**
 * Verifies the deterministic personal Google product-to-capability and OAuth
 * scope mapping used by local and Cloud connector forms, including a
 * regression table pinning the exact scope sets each product requests from
 * Google and a drift check against the shared contract catalog.
 */

import {
  GOOGLE_WORKSPACE_MCP_PRODUCTS,
  type GoogleWorkspaceMcpProduct,
} from "@elizaos/shared/contracts";
import { describe, expect, it } from "vitest";
import {
  capabilitiesForPersonalGoogleProducts,
  oauthScopesForPersonalGoogleProducts,
  PERSONAL_GOOGLE_MCP_PRODUCTS,
} from "./google-mcp-products";

const IDENTITY_SCOPES = [
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

/**
 * The exact least-privilege scope set each product requests from Google.
 * These sets are a wire contract: connections were granted against them, so
 * any change here forces re-consent and must be deliberate.
 */
const EXPECTED_PRODUCT_REQUEST_SCOPES: Record<
  GoogleWorkspaceMcpProduct,
  readonly string[]
> = {
  gmail: [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.modify",
  ],
  calendar: ["https://www.googleapis.com/auth/calendar.readonly"],
  drive: [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/drive.file",
  ],
  docs: [
    "https://www.googleapis.com/auth/documents.readonly",
    "https://www.googleapis.com/auth/documents",
  ],
  sheets: [
    "https://www.googleapis.com/auth/spreadsheets.readonly",
    "https://www.googleapis.com/auth/spreadsheets",
  ],
  slides: [
    "https://www.googleapis.com/auth/presentations.readonly",
    "https://www.googleapis.com/auth/presentations",
  ],
  chat: [
    "https://www.googleapis.com/auth/chat.messages.readonly",
    "https://www.googleapis.com/auth/chat.messages.create",
    "https://www.googleapis.com/auth/chat.spaces.readonly",
    "https://www.googleapis.com/auth/chat.memberships.readonly",
    "https://www.googleapis.com/auth/chat.users.readstate.readonly",
  ],
  people: [
    "https://www.googleapis.com/auth/contacts.readonly",
    "https://www.googleapis.com/auth/directory.readonly",
    "https://www.googleapis.com/auth/userinfo.profile",
  ],
  universalSearch: [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/chat.messages.readonly",
  ],
};

describe("personal Google MCP product catalog", () => {
  it("stays id-for-id aligned with the shared contract catalog", () => {
    expect(PERSONAL_GOOGLE_MCP_PRODUCTS.map((product) => product.id)).toEqual([
      ...GOOGLE_WORKSPACE_MCP_PRODUCTS,
    ]);
  });

  it("models Gmail as read, manage, and draft-only", () => {
    const gmail = PERSONAL_GOOGLE_MCP_PRODUCTS.find(
      (product) => product.id === "gmail",
    );
    expect(new Set(gmail?.capabilities)).toEqual(
      new Set(["gmail.read", "gmail.draft", "gmail.manage"]),
    );
    expect(gmail?.description.toLowerCase()).toContain("draft");
    expect(gmail?.description.toLowerCase()).toContain("not available");
    expect(JSON.stringify(gmail)).not.toContain("gmail.send");
  });

  it("requests exactly the pinned scope set for every product", () => {
    for (const product of GOOGLE_WORKSPACE_MCP_PRODUCTS) {
      expect(
        new Set(oauthScopesForPersonalGoogleProducts([product])),
        `scope request drift for ${product}`,
      ).toEqual(
        new Set([
          ...IDENTITY_SCOPES,
          ...EXPECTED_PRODUCT_REQUEST_SCOPES[product],
        ]),
      );
    }
  });

  it("deduplicates capabilities and uses narrow product scopes", () => {
    expect(
      new Set(capabilitiesForPersonalGoogleProducts(["gmail", "calendar"])),
    ).toEqual(
      new Set(["gmail.read", "gmail.draft", "gmail.manage", "calendar.read"]),
    );
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
