/**
 * Tests the read-only `androidContacts` provider against a mocked
 * `@elizaos/capacitor-contacts` bridge: it supersedes the LIST_CONTACTS action
 * and emits bounded address-book context as JSON.
 */
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

  it("reports the failure and surfaces it in the result when the bridge rejects", async () => {
    const boom = new Error("contacts permission denied");
    contactsMock.listContacts.mockRejectedValue(boom);
    const reportError = vi.fn();

    const result = await contactsProvider.get(
      { reportError } as unknown as IAgentRuntime,
      {} as Memory,
      {} as State,
    );

    // Native-bridge failure surfaces observably (RECENT_ERRORS) and in the
    // provider values — never a silently fabricated empty contact list.
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]?.[1]).toBe(boom);
    expect(result.values).toMatchObject({
      contactsAvailable: false,
      contactsCount: 0,
      contactsError: "contacts permission denied",
    });
    const data = result.data as { error?: string };
    expect(data.error).toBe("contacts permission denied");
  });
});
