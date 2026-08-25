/**
 * Verifies bridge capability routing and rejects tab mutations that the
 * companion cannot execute, preventing successful-looking false outcomes.
 */

import { describe, expect, it, vi } from "vitest";
import {
  BRIDGE_SUPPORTED_SUBACTIONS,
  bridgeSupports,
  dispatchBridgeCommand,
} from "./bridge-target";

function page() {
  return {
    url: "https://example.com/page",
    title: "Example",
    browser: "chrome",
    profileId: "p1",
    windowId: 1,
    tabId: 2,
    capturedAt: 123,
    mainText: "main text",
  };
}

function serviceWith({
  tabs = [],
  pageValue = null as ReturnType<typeof page> | null,
} = {}) {
  return {
    listBrowserTabs: vi.fn(async () => tabs),
    getCurrentBrowserPage: vi.fn(async () => pageValue),
  };
}

describe("bridge target capability manifest", () => {
  it("advertises only read-mostly subactions as supported", () => {
    expect([...BRIDGE_SUPPORTED_SUBACTIONS].sort()).toEqual([
      "get",
      "list",
      "state",
      "tab",
    ]);
  });

  it("excludes account-affecting subactions from the capability manifest", () => {
    // open/navigate/close/show/hide/back/forward/reload are session-gated
    // behind owner confirmation; advertising them would make the pre-dispatch
    // capability check select the bridge and then fail at execute time.
    for (const gated of [
      "open",
      "navigate",
      "close",
      "show",
      "hide",
      "back",
      "forward",
      "reload",
    ]) {
      expect(BRIDGE_SUPPORTED_SUBACTIONS.has(gated)).toBe(false);
    }
  });

  it("lists bridge tabs mapped to workspace tabs with a bridge partition", async () => {
    const service = serviceWith({
      tabs: [
        {
          id: "tab-1",
          title: "A",
          url: "https://a.example",
          profileId: "p1",
          activeInWindow: true,
          createdAt: 1,
          updatedAt: 2,
          lastFocusedAt: 3,
        },
      ],
    });
    const result = await dispatchBridgeCommand(service, {
      subaction: "list",
    } as never);
    expect(result).toMatchObject({
      mode: "desktop",
      subaction: "list",
      tabs: [
        {
          id: "tab-1",
          title: "A",
          url: "https://a.example",
          partition: "bridge:p1",
          kind: "standard",
          visible: true,
        },
      ],
    });
  });

  it("returns the current page context on state", async () => {
    const service = serviceWith({ pageValue: page() });
    const result = await dispatchBridgeCommand(service, {
      subaction: "state",
    } as never);
    expect(result).toMatchObject({
      subaction: "state",
      value: {
        url: "https://example.com/page",
        title: "Example",
        profileId: "p1",
      },
    });
  });

  it("returns null state when no page is attached", async () => {
    const service = serviceWith({ pageValue: null });
    const result = await dispatchBridgeCommand(service, {
      subaction: "state",
    } as never);
    expect(result).toMatchObject({ subaction: "state", value: null });
  });

  it("returns page text by default on get", async () => {
    const service = serviceWith({ pageValue: page() });
    const result = await dispatchBridgeCommand(service, {
      subaction: "get",
    } as never);
    expect(result).toMatchObject({ subaction: "get", value: "main text" });
  });

  it("returns the url when getMode=url", async () => {
    const service = serviceWith({ pageValue: page() });
    const result = await dispatchBridgeCommand(service, {
      subaction: "get",
      getMode: "url",
    } as never);
    expect(result).toMatchObject({
      subaction: "get",
      value: "https://example.com/page",
    });
  });

  it("returns null on get when no page is attached", async () => {
    const service = serviceWith({ pageValue: null });
    const result = await dispatchBridgeCommand(service, {
      subaction: "get",
    } as never);
    expect(result).toMatchObject({ subaction: "get", value: null });
  });

  it("rejects unknown subactions with a clear unsupported error", async () => {
    const service = serviceWith();
    await expect(
      dispatchBridgeCommand(service, { subaction: "eval" } as never),
    ).rejects.toThrow(
      'Browser bridge target does not support subaction "eval"',
    );
  });

  it("rejects session-gated subactions with the session-required error", async () => {
    const service = serviceWith();
    await expect(
      dispatchBridgeCommand(service, { subaction: "open" } as never),
    ).rejects.toThrow(/requires a recorded LifeOpsBrowserSession/);
    await expect(
      dispatchBridgeCommand(service, { subaction: "navigate" } as never),
    ).rejects.toThrow(/requires a recorded LifeOpsBrowserSession/);
  });

  it.each(["new", "switch", "close"] as const)(
    "rejects mutating tabAction=%s instead of returning a false-success tab list",
    async (tabAction) => {
      const service = serviceWith();
      expect(bridgeSupports({ subaction: "tab", tabAction })).toBe(false);
      await expect(
        dispatchBridgeCommand(service, { subaction: "tab", tabAction }),
      ).rejects.toThrow(/does not support subaction "tab"/);
      expect(service.listBrowserTabs).not.toHaveBeenCalled();
    },
  );

  it("never calls the service for unsupported subactions", async () => {
    const service = serviceWith();
    await expect(
      dispatchBridgeCommand(service, { subaction: "reload" } as never),
    ).rejects.toThrow(/requires a recorded LifeOpsBrowserSession/);
    expect(service.listBrowserTabs).not.toHaveBeenCalled();
    expect(service.getCurrentBrowserPage).not.toHaveBeenCalled();
  });
});
