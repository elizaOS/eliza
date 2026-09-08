/**
 * Exercises the real registered Capacitor web fallback through the contacts
 * provider, so unsupported address-book access cannot become empty context.
 */
import { Capacitor } from "@capacitor/core";
import { Contacts } from "@elizaos/capacitor-contacts";
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { expect, it, vi } from "vitest";
import { contactsProvider } from "./contacts";

it("reports unavailable planning context from the actual web bridge", async () => {
  expect(Capacitor.getPlatform()).toBe("web");
  await expect(Contacts.checkPermissions()).rejects.toMatchObject({
    code: "UNAVAILABLE",
  });
  await expect(Contacts.requestPermissions()).rejects.toMatchObject({
    code: "UNAVAILABLE",
  });

  const reportError = vi.fn();
  const result = await contactsProvider.get(
    { reportError } as unknown as IAgentRuntime,
    {} as Memory,
    {} as State,
  );
  const context = JSON.parse(result.text ?? "");
  expect(context.android_contacts.error).toContain("only available on Android");
  expect(context.android_contacts).not.toHaveProperty("items");
  expect(context.android_contacts).not.toHaveProperty("count");
  expect(result.values?.contactsAvailable).toBe(false);
  expect(result.values?.contactsError).toBe(context.android_contacts.error);
  expect(reportError).toHaveBeenCalledWith(
    "androidContacts.provider",
    expect.objectContaining({ code: "UNAVAILABLE" }),
  );
});
