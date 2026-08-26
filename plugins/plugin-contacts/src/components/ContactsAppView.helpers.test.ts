/**
 * Unit tests for ContactsAppView helper functions.
 */
import type { ContactSummary } from "@elizaos/capacitor-contacts";
import { describe, expect, it } from "vitest";
import { matchesQuery } from "./ContactsAppView.helpers";

describe("matchesQuery", () => {
  const contact: ContactSummary = {
    id: "c1",
    displayName: "Alice Smith",
    phoneNumbers: ["+15551234"],
    emailAddresses: ["alice@example.com"],
    lookupKey: "k1",
    starred: false,
  };

  it("matches display name, phone, or email case-insensitively", () => {
    expect(matchesQuery(contact, "alice")).toBe(true);
    expect(matchesQuery(contact, "SMITH")).toBe(true);
    expect(matchesQuery(contact, "5551234")).toBe(true);
    expect(matchesQuery(contact, "example.com")).toBe(true);
    expect(matchesQuery(contact, "bob")).toBe(false);
  });

  it("returns true for empty or whitespace-only queries", () => {
    expect(matchesQuery(contact, "")).toBe(true);
    expect(matchesQuery(contact, "   ")).toBe(true);
    expect(matchesQuery(contact, null as unknown as string)).toBe(true);
  });

  it("safely handles contacts with missing fields or undefined properties", () => {
    const sparseContact = {
      id: "c2",
    } as unknown as ContactSummary;
    expect(matchesQuery(sparseContact, "test")).toBe(false);
    expect(matchesQuery(null as unknown as ContactSummary, "test")).toBe(false);
  });
});
