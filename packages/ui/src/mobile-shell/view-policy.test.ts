import { describe, expect, it } from "vitest";
import {
  type MobileViewPolicyContext,
  mobileViewIsAvailable,
} from "./view-policy";

const ordinary: MobileViewPolicyContext = {
  implemented: true,
  managedCloud: false,
  nativeViews: new Set(),
};
describe("shared mobile capability policy", () => {
  it("admits installed ordinary views independently of product order or name", () => {
    for (const id of [
      "calendar",
      "wallet",
      "camera",
      "files",
      "new-plugin-view",
    ])
      expect(mobileViewIsAvailable({ id }, ordinary)).toBe(true);
    expect(
      mobileViewIsAvailable(
        { id: "wallet" },
        { ...ordinary, implemented: false },
      ),
    ).toBe(false);
  });
  it("requires the exact installed native adapter and never derives it from another view", () => {
    const one = { ...ordinary, nativeViews: new Set(["phone"]) };
    expect(mobileViewIsAvailable({ id: "phone" }, one)).toBe(true);
    expect(mobileViewIsAvailable({ id: "contacts" }, one)).toBe(false);
    expect(mobileViewIsAvailable({ id: "messages" }, ordinary)).toBe(false);
  });
  it("retains runtime and user visibility gates for both products", () => {
    expect(
      mobileViewIsAvailable(
        { id: "cloud", availability: "managed-cloud" },
        ordinary,
      ),
    ).toBe(false);
    expect(
      mobileViewIsAvailable(
        { id: "cloud", availability: "managed-cloud" },
        { ...ordinary, managedCloud: true },
      ),
    ).toBe(true);
    expect(
      mobileViewIsAvailable({ id: "inspect", viewKind: "developer" }, ordinary),
    ).toBe(false);
    expect(
      mobileViewIsAvailable(
        { id: "inspect", viewKind: "developer" },
        { ...ordinary, developer: true },
      ),
    ).toBe(true);
    expect(
      mobileViewIsAvailable({ id: "preview", viewKind: "preview" }, ordinary),
    ).toBe(false);
  });
});
