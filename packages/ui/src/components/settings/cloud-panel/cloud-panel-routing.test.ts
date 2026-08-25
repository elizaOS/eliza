/**
 * Unit tests for cloud panel routing: validates hash reading and navigation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  navigateCloudPanel,
  readCloudPanelHash,
  subscribeCloudPanelHash,
} from "./cloud-panel-routing.ts";

describe("cloud-panel-routing", () => {
  const globalScope = globalThis as unknown as { window?: unknown };

  beforeEach(() => {
    globalScope.window = {
      location: { hash: "#voice" },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
  });

  afterEach(() => {
    delete globalScope.window;
  });

  it("reads section id from window location hash", () => {
    const section = readCloudPanelHash();
    expect(section).toBe("voice");
  });

  it("navigates to section updating location hash", () => {
    navigateCloudPanel("connections");
    expect(
      (globalScope.window as { location: { hash: string } }).location.hash,
    ).toBe("#connections");
  });

  it("subscribes and unsubscribes from hashchange events", () => {
    const unsub = subscribeCloudPanelHash(() => {});
    expect(typeof unsub).toBe("function");
    unsub();
    expect(
      (globalScope.window as { removeEventListener: ReturnType<typeof vi.fn> })
        .removeEventListener,
    ).toHaveBeenCalled();
  });
});
