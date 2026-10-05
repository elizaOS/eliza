/**
 * Exercises Contacts view helpers and interaction dispatch against the real
 * registered Capacitor web fallback. Unsupported operations must propagate
 * instead of returning a successful empty address book or write receipt.
 */
import { describe, expect, it } from "vitest";
import { loadContactsState } from "./ContactsAppView.helpers";
import { interact } from "./ContactsAppView.interact";

describe("Contacts consumers on an unsupported platform", () => {
  it("propagates unavailable address-book reads to the view", async () => {
    await expect(
      loadContactsState({ limit: 25, query: "Ada" }),
    ).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    await expect(
      interact("list-contacts", { query: "Ada" }),
    ).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
  });

  it("validates create input and rejects unsupported writes", async () => {
    await expect(
      interact("create-contact", { displayName: " \t " }),
    ).rejects.toThrow("displayName is required");
    await expect(
      interact("create-contact", { displayName: "Ada Lovelace" }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("validates import input and rejects unsupported imports", async () => {
    await expect(interact("import-vcard", { vcardText: "" })).rejects.toThrow(
      "vcardText is required",
    );
    await expect(
      interact("import-vcard", { vcardText: "BEGIN:VCARD\nFN:Ada\nEND:VCARD" }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("rejects unsupported interaction capabilities", async () => {
    await expect(interact("nope")).rejects.toThrow(
      'Unsupported capability "nope"',
    );
  });
});
