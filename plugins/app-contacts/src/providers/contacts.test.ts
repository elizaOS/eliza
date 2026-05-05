import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const contactsMock = vi.hoisted(() => ({
  listContacts: vi.fn(),
}));

vi.mock("@elizaos/capacitor-contacts", () => ({
  Contacts: contactsMock,
}));

import { appContactsPlugin } from "../plugin";
import { contactsProvider } from "./contacts";

describe("CONTACTS provider", () => {
  beforeEach(() => {
    contactsMock.listContacts.mockReset();
  });

  it("replaces the read-only LIST_CONTACTS action with a dynamic provider", () => {
    expect(appContactsPlugin.actions ?? []).toHaveLength(0);
    expect((appContactsPlugin.providers ?? []).map((p) => p.name)).toContain(
      "CONTACTS",
    );
    expect(contactsProvider.dynamic).toBe(true);
  });

  it("returns bounded address-book context without importing the React UI", async () => {
    const contacts = [
      {
        id: "1",
        lookupKey: "ada",
        displayName: "Ada Lovelace",
        phoneNumbers: ["+15551234567"],
        emailAddresses: ["ada@example.com"],
        starred: true,
      },
    ];
    contactsMock.listContacts.mockResolvedValue({ contacts });

    const result = await contactsProvider.get(
      {} as IAgentRuntime,
      {} as Memory,
      {} as State,
    );

    expect(contactsMock.listContacts).toHaveBeenCalledWith({ limit: 50 });
    expect(result.text).toContain("contacts[1]:");
    expect(result.text).toContain("Ada Lovelace");
    expect(result.values).toMatchObject({
      contactsAvailable: true,
      contactsCount: 1,
    });
    expect(result.data).toMatchObject({ contacts, count: 1, limit: 50 });
  });
});
