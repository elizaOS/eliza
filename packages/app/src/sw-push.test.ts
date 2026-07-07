/**
 * Contract tests for the service-worker web-push logic (`public/sw-push.js`).
 *
 * The SW module is dependency-free plain JS attached to `self.__elizaPush`. We
 * load it into the jsdom global (with a stubbed `self`) and exercise the pure
 * helpers directly — payload parsing, notification shaping, badge sync, and
 * click routing — without a real ServiceWorkerGlobalScope.
 */

import { readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

interface PushApi {
  DEFAULT_TITLE: string;
  DEFAULT_ICON: string;
  DEFAULT_BADGE: string;
  DEFAULT_TAG: string;
  parsePushData: (data: unknown) => Record<string, unknown>;
  buildNotification: (payload: unknown) => {
    title: string;
    options: Record<string, unknown>;
  };
  badgeCountFromPayload: (payload: unknown) => number | null;
  applyBadge: (nav: unknown, count: number | null) => Promise<unknown>;
  clearBadge: (nav: unknown) => Promise<unknown>;
  resolveClickTarget: (data: unknown, origin: string) => string;
  focusOrOpen: (
    clients: unknown,
    targetPath: string,
    origin: string,
  ) => Promise<unknown>;
  dispatchToVisibleClients: (
    clients: unknown,
    payload: unknown,
    origin?: string,
  ) => Promise<boolean>;
  isSafeAppPath: (path: unknown) => boolean;
}

let push: PushApi;

beforeAll(() => {
  // Load and evaluate the plain-JS SW module against the jsdom global so its
  // IIFE attaches `self.__elizaPush`. `self` is aliased to the jsdom window.
  const scope = globalThis as unknown as {
    self?: unknown;
    __elizaPush?: PushApi;
  };
  scope.self = globalThis;
  const src = readFileSync(
    join(__dirname, "..", "public", "sw-push.js"),
    "utf8",
  );
  // eslint-disable-next-line no-new-func
  new Function("module", "self", src)({ exports: {} }, globalThis);
  push = (globalThis as unknown as { __elizaPush: PushApi }).__elizaPush;
});

describe("parsePushData", () => {
  it("returns {} for null/undefined data", () => {
    expect(push.parsePushData(undefined)).toEqual({});
    expect(push.parsePushData(null)).toEqual({});
  });

  it("parses a JSON payload via data.json()", () => {
    const data = { json: () => ({ title: "Hi", body: "there" }) };
    expect(push.parsePushData(data)).toEqual({ title: "Hi", body: "there" });
  });

  it("falls back to data.text() + JSON.parse", () => {
    const data = { text: () => '{"title":"T"}' };
    expect(push.parsePushData(data)).toEqual({ title: "T" });
  });

  it("returns {} when data.json() throws (non-JSON push)", () => {
    const data = {
      json: () => {
        throw new Error("not json");
      },
    };
    expect(push.parsePushData(data)).toEqual({});
  });

  it("returns {} when text() yields invalid JSON", () => {
    expect(push.parsePushData({ text: () => "<<not json>>" })).toEqual({});
  });

  it("returns {} for a non-object JSON payload", () => {
    expect(push.parsePushData({ json: () => 42 })).toEqual({});
  });
});

describe("buildNotification", () => {
  it("defaults to notification image assets that exist in public/", async () => {
    expect(push.DEFAULT_ICON).toBe(
      "/brand/favicons/android-chrome-192x192.png",
    );
    expect(push.DEFAULT_BADGE).toBe(
      "/brand/favicons/android-chrome-192x192.png",
    );
    await expect(
      access(join(__dirname, "..", "public", push.DEFAULT_ICON)),
    ).resolves.toBeUndefined();
    await expect(
      access(join(__dirname, "..", "public", push.DEFAULT_BADGE)),
    ).resolves.toBeUndefined();
  });

  it("applies sane defaults for an empty payload", () => {
    const { title, options } = push.buildNotification({});
    expect(title).toBe(push.DEFAULT_TITLE);
    expect(options.body).toBe("");
    expect(options.icon).toBe(push.DEFAULT_ICON);
    expect(options.badge).toBe(push.DEFAULT_BADGE);
    expect(options.tag).toBe(push.DEFAULT_TAG);
    expect(options.renotify).toBe(false);
    expect(options.requireInteraction).toBe(false);
    expect(options.silent).toBe(false);
  });

  it("carries title/body/tag/renotify from the payload", () => {
    const { title, options } = push.buildNotification({
      title: "Agent Sol",
      body: "your build passed",
      tag: "conv-42",
      renotify: true,
      requireInteraction: true,
    });
    expect(title).toBe("Agent Sol");
    expect(options.body).toBe("your build passed");
    expect(options.tag).toBe("conv-42");
    expect(options.renotify).toBe(true);
    expect(options.requireInteraction).toBe(true);
  });

  it("carries conversation/agent ids + deepLink onto data", () => {
    const { options } = push.buildNotification({
      data: {
        deepLink: "/?conversation=abc",
        conversationId: "abc",
        agentId: "sol",
        extra: "kept",
      },
    });
    expect(options.data).toMatchObject({
      deepLink: "/?conversation=abc",
      conversationId: "abc",
      agentId: "sol",
      extra: "kept",
    });
  });

  it("drops non-string ids and falls back on blank title", () => {
    const { title, options } = push.buildNotification({
      title: "   ",
      data: { conversationId: 123, agentId: null, deepLink: {} },
    });
    expect(title).toBe(push.DEFAULT_TITLE);
    const data = options.data as Record<string, unknown>;
    expect(data.conversationId).toBeUndefined();
    expect(data.agentId).toBeUndefined();
    expect(data.deepLink).toBeUndefined();
  });
});

describe("badgeCountFromPayload", () => {
  it("returns null when no numeric count is present", () => {
    expect(push.badgeCountFromPayload({})).toBeNull();
    expect(push.badgeCountFromPayload({ badgeCount: "3" })).toBeNull();
    expect(push.badgeCountFromPayload({ badgeCount: -1 })).toBeNull();
    expect(push.badgeCountFromPayload({ badgeCount: Number.NaN })).toBeNull();
  });

  it("floors a valid count", () => {
    expect(push.badgeCountFromPayload({ badgeCount: 5 })).toBe(5);
    expect(push.badgeCountFromPayload({ badgeCount: 2.9 })).toBe(2);
    expect(push.badgeCountFromPayload({ badgeCount: 0 })).toBe(0);
  });
});

describe("applyBadge / clearBadge (feature detection)", () => {
  it("no-ops when count is null", async () => {
    const setAppBadge = vi.fn();
    await push.applyBadge({ setAppBadge }, null);
    expect(setAppBadge).not.toHaveBeenCalled();
  });

  it("no-ops when setAppBadge is unsupported", async () => {
    await expect(push.applyBadge({}, 3)).resolves.toBeUndefined();
  });

  it("sets the badge to the provided count", async () => {
    const setAppBadge = vi.fn().mockResolvedValue(undefined);
    await push.applyBadge({ setAppBadge }, 4);
    expect(setAppBadge).toHaveBeenCalledWith(4);
  });

  it("clears (not sets) when count <= 0 and clearAppBadge exists", async () => {
    const setAppBadge = vi.fn();
    const clearAppBadge = vi.fn().mockResolvedValue(undefined);
    await push.applyBadge({ setAppBadge, clearAppBadge }, 0);
    expect(clearAppBadge).toHaveBeenCalled();
    expect(setAppBadge).not.toHaveBeenCalled();
  });

  it("swallows a rejecting setAppBadge", async () => {
    const setAppBadge = vi.fn().mockRejectedValue(new Error("nope"));
    await expect(push.applyBadge({ setAppBadge }, 2)).resolves.toBeUndefined();
  });

  it("clearBadge no-ops when unsupported and calls when supported", async () => {
    await expect(push.clearBadge({})).resolves.toBeUndefined();
    const clearAppBadge = vi.fn().mockResolvedValue(undefined);
    await push.clearBadge({ clearAppBadge });
    expect(clearAppBadge).toHaveBeenCalled();
  });
});

describe("resolveClickTarget", () => {
  const origin = "https://app.example";

  it("prefers a safe root-relative deepLink", () => {
    expect(
      push.resolveClickTarget({ deepLink: "/settings/voice" }, origin),
    ).toBe("/settings/voice");
  });

  it("rejects an unsafe (absolute/scheme-relative) deepLink and uses ids", () => {
    expect(
      push.resolveClickTarget(
        { deepLink: "https://evil.example", conversationId: "c1" },
        origin,
      ),
    ).toBe("/?conversation=c1");
    expect(push.resolveClickTarget({ deepLink: "//evil" }, origin)).toBe("/");
    expect(push.resolveClickTarget({ deepLink: "/\\evil.com" }, origin)).toBe(
      "/",
    );
  });

  it("builds a conversation url with agent when present", () => {
    expect(
      push.resolveClickTarget({ conversationId: "c9", agentId: "sol" }, origin),
    ).toBe("/?conversation=c9&agent=sol");
  });

  it("falls back to root when nothing routable", () => {
    expect(push.resolveClickTarget({}, origin)).toBe("/");
    expect(push.resolveClickTarget(null, origin)).toBe("/");
  });
});

describe("focusOrOpen", () => {
  const origin = "https://app.example";

  it("focuses an existing same-origin client and posts a navigate message", async () => {
    const focus = vi.fn().mockResolvedValue(undefined);
    const postMessage = vi.fn();
    const openWindow = vi.fn();
    const clientsLike = {
      matchAll: vi
        .fn()
        .mockResolvedValue([{ url: `${origin}/chat`, focus, postMessage }]),
      openWindow,
    };
    await push.focusOrOpen(clientsLike, "/?conversation=c1", origin);
    expect(focus).toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({
      type: "eliza:push-navigate",
      path: "/?conversation=c1",
    });
    expect(openWindow).not.toHaveBeenCalled();
  });

  it("opens a new window when no client is open", async () => {
    const openWindow = vi.fn().mockResolvedValue({});
    const clientsLike = {
      matchAll: vi.fn().mockResolvedValue([]),
      openWindow,
    };
    await push.focusOrOpen(clientsLike, "/?conversation=c2", origin);
    expect(openWindow).toHaveBeenCalledWith(`${origin}/?conversation=c2`);
  });

  it("never opens a foreign origin after URL normalization", async () => {
    const openWindow = vi.fn().mockResolvedValue({});
    const clientsLike = {
      matchAll: vi.fn().mockResolvedValue([]),
      openWindow,
    };
    await push.focusOrOpen(clientsLike, "/\\evil.com", origin);
    expect(openWindow).toHaveBeenCalledWith(`${origin}/`);
  });

  it("ignores a cross-origin client and opens a fresh window", async () => {
    const openWindow = vi.fn().mockResolvedValue({});
    const clientsLike = {
      matchAll: vi
        .fn()
        .mockResolvedValue([
          { url: "https://other.example/x", focus: vi.fn() },
        ]),
      openWindow,
    };
    await push.focusOrOpen(clientsLike, "/", origin);
    expect(openWindow).toHaveBeenCalled();
  });

  it("resolves null when clients API is absent", async () => {
    await expect(push.focusOrOpen({}, "/", origin)).resolves.toBeNull();
  });
});

describe("dispatchToVisibleClients (foreground suppression)", () => {
  const origin = "https://app.example";
  const payload = { title: "Reply", conversationId: "c1" };

  it("posts the payload to a VISIBLE same-origin client and reports in-app delivery", async () => {
    const postMessage = vi.fn();
    const clientsLike = {
      matchAll: vi
        .fn()
        .mockResolvedValue([
          { url: `${origin}/chat`, visibilityState: "visible", postMessage },
        ]),
    };
    const delivered = await push.dispatchToVisibleClients(
      clientsLike,
      payload,
      origin,
    );
    expect(delivered).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({
      type: "eliza:push-inapp",
      payload,
    });
  });

  it("reports NOT delivered when the only client is hidden (SW then shows the OS notification)", async () => {
    const postMessage = vi.fn();
    const clientsLike = {
      matchAll: vi
        .fn()
        .mockResolvedValue([
          { url: `${origin}/chat`, visibilityState: "hidden", postMessage },
        ]),
    };
    const delivered = await push.dispatchToVisibleClients(
      clientsLike,
      payload,
      origin,
    );
    expect(delivered).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("accepts a focused client even without visibilityState", async () => {
    const postMessage = vi.fn();
    const clientsLike = {
      matchAll: vi
        .fn()
        .mockResolvedValue([
          { url: `${origin}/chat`, focused: true, postMessage },
        ]),
    };
    expect(
      await push.dispatchToVisibleClients(clientsLike, payload, origin),
    ).toBe(true);
    expect(postMessage).toHaveBeenCalled();
  });

  it("ignores a VISIBLE cross-origin client (does not suppress the notification)", async () => {
    const postMessage = vi.fn();
    const clientsLike = {
      matchAll: vi.fn().mockResolvedValue([
        {
          url: "https://other.example/x",
          visibilityState: "visible",
          postMessage,
        },
      ]),
    };
    expect(
      await push.dispatchToVisibleClients(clientsLike, payload, origin),
    ).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("resolves false when clients.matchAll is unavailable", async () => {
    expect(await push.dispatchToVisibleClients({}, payload, origin)).toBe(
      false,
    );
  });
});
