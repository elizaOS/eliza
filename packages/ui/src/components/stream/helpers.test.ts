/** Verifies the stream-view window-size constants and pop-out-mode detector through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Unit coverage for stream/helpers: PIP/FULL dimensions and the
 * module-load-time IS_POPOUT probe across query-string, hash-query,
 * missing-window, and precedence branches. Each IS_POPOUT case reloads the
 * module fresh so its load-time URL probe runs against the staged location.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { FULL_SIZE, PIP_SIZE } from "./helpers";

async function loadIsPopout(): Promise<boolean> {
  vi.resetModules();
  const mod = await import("./helpers");
  return mod.IS_POPOUT;
}

function stageUrl(url: string): void {
  window.history.replaceState(null, "", url);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PIP_SIZE and FULL_SIZE", () => {
  it("exposes the documented PIP capture dimensions (640x360)", () => {
    expect(PIP_SIZE).toEqual({ width: 640, height: 360 });
  });

  it("exposes the documented full-stream dimensions (1280x720)", () => {
    expect(FULL_SIZE).toEqual({ width: 1280, height: 720 });
  });
});

describe("IS_POPOUT", () => {
  it("is false on a plain document without a popout flag", async () => {
    stageUrl("http://localhost/");
    expect(await loadIsPopout()).toBe(false);
  });

  it("detects a bare ?popout flag in the query string", async () => {
    stageUrl("http://localhost/stream?popout");
    expect(await loadIsPopout()).toBe(true);
  });

  it("detects a valued ?popout=1 flag in the query string", async () => {
    stageUrl("http://localhost/stream?popout=1");
    expect(await loadIsPopout()).toBe(true);
  });

  it("ignores unrelated query parameters", async () => {
    stageUrl("http://localhost/stream?tab=chat&agent=nux");
    expect(await loadIsPopout()).toBe(false);
  });

  it("routes file:/electrobun-style popouts through the hash query", async () => {
    stageUrl("http://localhost/#/stream?popout=1");
    expect(await loadIsPopout()).toBe(true);
  });

  it("ignores a hash without a query section", async () => {
    stageUrl("http://localhost/#/stream");
    expect(await loadIsPopout()).toBe(false);
  });

  it("ignores hash query parameters other than popout", async () => {
    stageUrl("http://localhost/#/stream?tab=chat");
    expect(await loadIsPopout()).toBe(false);
  });

  it("prefers the query string over the hash when both exist", async () => {
    stageUrl("http://localhost/stream?tab=chat#/stream?popout=1");
    expect(await loadIsPopout()).toBe(false);
  });

  it("reports false when window itself is absent (SSR)", async () => {
    vi.stubGlobal("window", undefined);
    expect(await loadIsPopout()).toBe(false);
  });

  it("reports false when window has no location object", async () => {
    vi.stubGlobal("window", {});
    expect(await loadIsPopout()).toBe(false);
  });

  it("tolerates a location without search or hash fields", async () => {
    vi.stubGlobal("window", { location: {} });
    expect(await loadIsPopout()).toBe(false);
  });
});
