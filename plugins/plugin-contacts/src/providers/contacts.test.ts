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

describe("androidContacts provider", () => {
  beforeEach(() => {
    contactsMock.listContacts.mockReset();
  });

  it("replaces the read-only LIST_CONTACTS action with a dynamic provider", () => {
    expect(appContactsPlugin.actions ?? []).toHaveLength(0);
    expect((appContactsPlugin.providers ?? []).map((p) => p.name)).toContain(
      "androidContacts",
    );
    expect(contactsProvider.dynamic).toBe(true);
  });

  it("returns bounded address-book context as JSON context", async () => {
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
    expect(typeof result.text).toBe("string");
    expect(result.text).toContain("android_contacts");
    expect(result.text).toContain("Ada Lovelace");
    expect(result.values).toMatchObject({
      contactsAvailable: true,
      contactsCount: 1,
    });
    const data = result.data as {
      contacts: { id: string; displayName: string }[];
      count: number;
      limit: number;
    };
    expect(data.count).toBe(1);
    expect(data.limit).toBe(50);
    expect(data.contacts[0]).toMatchObject({
      id: "1",
      displayName: "Ada Lovelace",
      starred: true,
    });
  });
});
