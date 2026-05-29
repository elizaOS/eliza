import { describe, expect, it } from "vitest";
import {
  resolveProactiveDeliverySource,
  resolveProactiveOwnerContact,
} from "./proactive-worker";

describe("proactive delivery routing", () => {
  it("routes native app activity collector signals through client chat", () => {
    expect(resolveProactiveDeliverySource("macos_activity_collector")).toBe(
      "client_chat",
    );
  });

  it("does not require an owner contact entry for macOS activity signals", () => {
    expect(
      resolveProactiveOwnerContact({
        targetPlatform: "macos_activity_collector",
        ownerEntityId: "owner-entity",
        ownerContacts: {},
      }),
    ).toEqual({
      source: "client_chat",
      contact: { entityId: "owner-entity" },
    });
  });
});
