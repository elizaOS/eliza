/**
 * Tests for `ContactsWeb`, the web/node fallback used when no Android
 * bridge is present — pure in-process assertions, no device or mock bridge.
 */
import { describe, expect, it } from "vitest";

import { ContactsWeb } from "./web";

describe("ContactsWeb fallback", () => {
  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN])(
    "rejects malformed listContacts limit %s",
    async (limit) => {
      const contacts = new ContactsWeb();

      await expect(contacts.listContacts({ limit })).rejects.toThrow(
        "limit must be a positive safe integer",
      );
    },
  );

  it("rejects valid queries because no address book is available", async () => {
    const contacts = new ContactsWeb();

    await expect(
      contacts.listContacts({ limit: 25, query: "../../ada" }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("accepts explicit limits above the former arbitrary ceiling", async () => {
    const contacts = new ContactsWeb();

    await expect(contacts.listContacts({ limit: 5_000 })).rejects.toMatchObject(
      {
        code: "UNAVAILABLE",
      },
    );
  });

  it("cannot grant access to an unsupported address book", async () => {
    const contacts = new ContactsWeb();
    await expect(contacts.checkPermissions()).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    await expect(contacts.requestPermissions()).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
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
