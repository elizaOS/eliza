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

  it("returns null when uiExtension exists but has no detailPanelId", () => {
    expect(getAppDetailExtension({ uiExtension: {} } as never)).toBeNull();
  });

  it("returns null for an empty-string panel id even when registered", () => {
    const component = vi.fn();
    registerDetailExtension("", component as never);
    expect(
      getAppDetailExtension({
        uiExtension: { detailPanelId: "" },
      } as never),
    ).toBeNull();
  });

  it("resolves multiple registered panel ids independently", () => {
    const inbox = vi.fn();
    const wallet = vi.fn();
    registerDetailExtension("panel-multi-a", inbox as never);
    registerDetailExtension("panel-multi-b", wallet as never);
    expect(
      getAppDetailExtension({
        uiExtension: { detailPanelId: "panel-multi-a" },
      } as never),
    ).toBe(inbox);
    expect(
      getAppDetailExtension({
        uiExtension: { detailPanelId: "panel-multi-b" },
      } as never),
    ).toBe(wallet);
  });
});
