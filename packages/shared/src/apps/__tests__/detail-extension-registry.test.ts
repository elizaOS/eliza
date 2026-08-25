import { describe, expect, it, vi } from "vitest";
import {
  getAppDetailExtension,
  registerDetailExtension,
} from "../detail-extension-registry.ts";

describe("detail-extension-registry", () => {
  it("returns null when the app has no detail panel id", () => {
    expect(getAppDetailExtension({} as never)).toBeNull();
  });

  it("returns null for unregistered panel ids", () => {
    expect(
      getAppDetailExtension({
        uiExtension: { detailPanelId: "nope" },
      } as never),
    ).toBeNull();
  });

  it("returns the registered component", () => {
    const component = vi.fn();
    registerDetailExtension("panel-1", component as never);
    expect(
      getAppDetailExtension({
        uiExtension: { detailPanelId: "panel-1" },
      } as never),
    ).toBe(component);
  });

  it("returns the latest registration for a panel id", () => {
    const first = vi.fn();
    const second = vi.fn();
    registerDetailExtension("panel-2", first as never);
    registerDetailExtension("panel-2", second as never);
    expect(
      getAppDetailExtension({
        uiExtension: { detailPanelId: "panel-2" },
      } as never),
    ).toBe(second);
  });
});
