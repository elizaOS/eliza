import { describe, expect, it } from "vitest";

import { ContactsWeb } from "./web";

describe("ContactsWeb fallback", () => {
  it.each([
    0,
    -1,
    501,
    Number.POSITIVE_INFINITY,
    Number.NaN,
  ])("rejects malformed listContacts limit %s", async (limit) => {
    const contacts = new ContactsWeb();

    await expect(contacts.listContacts({ limit })).rejects.toThrow(
      "limit must be between 1 and 500",
    );
  });

  it("returns an empty contact list for valid web fallback queries", async () => {
    const contacts = new ContactsWeb();

    await expect(
      contacts.listContacts({ limit: 25.9, query: "../../ada" }),
    ).resolves.toEqual({ contacts: [] });
  });

  it("rejects malformed create/import payloads before Android-only fallback errors", async () => {
    const contacts = new ContactsWeb();

    await expect(
      contacts.createContact({ displayName: " \t\n " }),
    ).rejects.toThrow("displayName is required");
    await expect(
      contacts.createContact({
        displayName: ["Ada Lovelace"] as unknown as string,
      }),
    ).rejects.toThrow("displayName is required");
    await expect(contacts.importVCard({ vcardText: "" })).rejects.toThrow(
      "vcardText is required",
    );
    await expect(
      contacts.importVCard({
        vcardText: { text: "BEGIN:VCARD" } as unknown as string,
      }),
    ).rejects.toThrow("vcardText is required");
    await expect(
      contacts.createContact({ displayName: "Ada Lovelace" }),
    ).rejects.toThrow("Contacts are only available on Android.");
    await expect(
      contacts.importVCard({ vcardText: "BEGIN:VCARD\nFN:Ada\nEND:VCARD" }),
    ).rejects.toThrow("Contact imports are only available on Android.");
  });
});
