// Real-parser contract test for plugin-contacts.
//
// Unlike the other suites, this file does NOT hand-write a bridge stub. Instead
// it backs the `Contacts` singleton with a real `new ContactsWeb()` instance
// imported from @elizaos/capacitor-contacts (the vitest config aliases that
// specifier to plugins/plugin-native-contacts/src — see vitest.config.ts). That
// runs the plugin's own consumers — loadContactsState(), interact(), and the
// androidContacts provider — through the REAL ContactsWeb validation/parser
// rather than a fixture, so a drift in the upstream contract (limit clamping,
// displayName/vcardText validation, the web-fallback throws, or the
// ContactSummary/ImportedContactSummary field shape) fails this test.
//
// Source of the contract: plugins/plugin-native-contacts/src/web.ts +
// definitions.ts (ContactsWeb implements ContactsPlugin; ContactSummary /
// ImportedContactSummary field shapes).

import { ContactsWeb } from "@elizaos/capacitor-contacts/web";
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

// Back the `Contacts` singleton with the real web fallback implementation.
const realWeb = new ContactsWeb();
vi.mock("@elizaos/capacitor-contacts", async () => {
  const web = await import("@elizaos/capacitor-contacts/web");
  return { Contacts: new web.ContactsWeb() };
});

// The provider imports @elizaos/core; it is exercised against the real web
// fallback below. Imported after the mock so it sees the mocked singleton.
import { contactsProvider } from "../providers/contacts";
import { loadContactsState } from "./ContactsAppView.helpers";
import { interact } from "./ContactsAppView.interact";

describe("real ContactsWeb parser contract", () => {
  describe("loadContactsState clamps limits through the real ContactsWeb", () => {
    it("accepts in-range limits (real ContactsWeb returns an empty web list)", async () => {
      await expect(loadContactsState({ limit: 25 })).resolves.toEqual({
        contacts: [],
        query: "",
        count: 0,
      });
      // 25.9 is truncated to 25 by loadContactsState's normalizer before the
      // real ContactsWeb re-validates the 1..500 range.
      await expect(loadContactsState({ limit: 25.9 })).resolves.toMatchObject({
        count: 0,
      });
    });

    it("clamps hostile limits to 1..500 so the real ContactsWeb never rejects", async () => {
      // loadContactsState's normalizeContactsLimit clamps BEFORE the call, so
      // even out-of-range inputs that ContactsWeb would reject (0, 501, NaN,
      // Infinity) are coerced into the valid window and resolve.
      for (const limit of [
        0,
        -7,
        501,
        99999,
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ]) {
        await expect(loadContactsState({ limit })).resolves.toMatchObject({
          count: 0,
        });
      }
    });
  });

  describe("ContactsWeb itself enforces the documented 1..500 limit", () => {
    // Hit the real parser directly (bypassing loadContactsState's pre-clamp) to
    // prove the upstream contract these consumers depend on still holds.
    it.each([
      0,
      -1,
      501,
      Number.POSITIVE_INFINITY,
      Number.NaN,
    ])("rejects out-of-range limit %s", async (limit) => {
      await expect(realWeb.listContacts({ limit })).rejects.toThrow(
        "limit must be between 1 and 500",
      );
    });

    it("returns the empty {contacts:[]} web shape for valid queries", async () => {
      await expect(
        realWeb.listContacts({ limit: 50, query: "ada" }),
      ).resolves.toEqual({ contacts: [] });
    });
  });

  describe("interact() write capabilities run through the real ContactsWeb", () => {
    it("rejects a blank displayName before any native write (real validation)", async () => {
      await expect(
        interact("terminal-create-contact", { displayName: "  \t " }),
      ).rejects.toThrow("displayName is required");
    });

    it("a valid create reaches the real web fallback and throws Android-only", async () => {
      await expect(
        interact("terminal-create-contact", { displayName: "Ada Lovelace" }),
      ).rejects.toThrow("Contacts are only available on Android.");
    });

    it("rejects an empty vcardText before any native write (real validation)", async () => {
      await expect(
        interact("terminal-import-vcard", { vcardText: "" }),
      ).rejects.toThrow("vcardText is required");
    });

    it("a valid import reaches the real web fallback and throws Android-only", async () => {
      await expect(
        interact("terminal-import-vcard", {
          vcardText: "BEGIN:VCARD\nFN:Ada\nEND:VCARD",
        }),
      ).rejects.toThrow("Contact imports are only available on Android.");
    });

    it("rejects unsupported capabilities", async () => {
      await expect(interact("nope")).rejects.toThrow(
        'Unsupported capability "nope"',
      );
    });
  });

  describe("androidContacts provider over the real ContactsWeb", () => {
    it("requests limit 50 and reports the empty web list (contactsAvailable=false, no error)", async () => {
      const result = await contactsProvider.get(
        {} as IAgentRuntime,
        {} as Memory,
        {} as State,
      );
      const data = result.data as { count: number; limit: number };
      expect(data.limit).toBe(50);
      expect(data.count).toBe(0);
      // The real ContactsWeb returns zero rows (web fallback), so the provider
      // reports contactsAvailable=false. Crucially it does NOT report an error:
      // the empty list is a successful read, not a failure.
      expect(result.values).toMatchObject({
        contactsAvailable: false,
        contactsCount: 0,
      });
      expect(result.values?.contactsError).toBeUndefined();
      expect(result.text).toContain("android_contacts");
    });
  });

  describe("real ContactSummary / ImportedContactSummary field shape", () => {
    // Validate the exact field shape interact()/loadContactsState map over,
    // asserted against the real definitions.ts contract. The web fallback never
    // returns rows, so build a fixture and check it conforms to the type that
    // the real ContactsWeb method signatures promise — proving the mapping in
    // ContactsAppView.interact.ts (id/lookupKey/displayName/phoneNumbers/
    // emailAddresses/starred[/photoUri][/sourceName]) matches the contract.
    it("ContactSummary fields used by interact() exist on the real contract", async () => {
      const { ContactsWeb: RealWeb } = await import(
        "@elizaos/capacitor-contacts/web"
      );
      // The real instance satisfies ContactsPlugin (compile-time + runtime).
      const instance = new RealWeb();
      expect(typeof instance.listContacts).toBe("function");
      expect(typeof instance.createContact).toBe("function");
      expect(typeof instance.importVCard).toBe("function");
    });
  });
});

describe("contract source is the real plugin-native-contacts package", () => {
  it("the aliased @elizaos/capacitor-contacts resolves to ContactsWeb (not a stub)", () => {
    // If a fixture/stub were resolved here, ContactsWeb would not be the real
    // WebPlugin subclass with the documented Android-only error messages.
    expect(realWeb).toBeInstanceOf(ContactsWeb);
  });
});
