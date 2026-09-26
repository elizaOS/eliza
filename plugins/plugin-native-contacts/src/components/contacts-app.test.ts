/**
 * Tests the contacts overlay-app descriptor and its registration against a
 * mocked `@elizaos/ui/apps/overlay-app-api` overlay registry: Android-only metadata and the
 * exported descriptor.
 */

import { describe, expect, it, vi } from "vitest";
import {
  CONTACTS_APP_NAME,
  contactsApp,
  registerContactsApp,
} from "./contacts-app";

const registerOverlayApp = vi.hoisted(() => vi.fn());
vi.mock("@elizaos/ui/apps/overlay-app-registry", () => ({
  registerOverlayApp,
}));
describe("contacts overlay registration", () => {
  it("describes an Android-only contacts overlay app", () => {
    expect(contactsApp).toMatchObject({
      name: CONTACTS_APP_NAME,
      displayName: "Contacts",
      description: "Read and create entries in the Android address book",
      category: "system",
      androidOnly: true,
    });
    expect(contactsApp.loader).toEqual(expect.any(Function));
  });
  it("registers the exported overlay descriptor", () => {
    registerContactsApp();
    expect(registerOverlayApp).toHaveBeenCalledTimes(1);
    expect(registerOverlayApp).toHaveBeenCalledWith(contactsApp);
  });
});
