/**
 * Tab lifecycle coverage for the web (JSDOM) browser workspace backend.
 *
 * The `tab` subaction (list / new / switch / close) drives pure in-process
 * `webWorkspaceState` in web mode — no network, no desktop bridge — so it is
 * fully exercised offline. Previously this surface had no direct test coverage.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetBrowserWorkspaceStateForTests,
  executeBrowserWorkspaceCommand,
  openBrowserWorkspaceTab,
} from "../browser-workspace.js";

const webEnv: NodeJS.ProcessEnv = {};

describe("browser workspace tab lifecycle (web mode)", () => {
  beforeEach(async () => {
    await __resetBrowserWorkspaceStateForTests();
  });

  it("lists, opens, switches, and closes tabs in web mode", async () => {
    // Seed one tab.
    const first = await openBrowserWorkspaceTab({ url: "about:blank" }, webEnv);
    expect(first.id).toMatch(/^btab_/);

    // tab.new — a second tab via the command router.
    const created = await executeBrowserWorkspaceCommand(
      { subaction: "tab", tabAction: "new", url: "about:blank" },
      webEnv,
    );
    expect(created.mode).toBe("web");
    expect(created.tab?.id).toBeDefined();
    expect(created.tab?.id).not.toBe(first.id);
    const secondId = created.tab?.id as string;

    // tab.list — both tabs present.
    const listed = await executeBrowserWorkspaceCommand(
      { subaction: "tab", tabAction: "list" },
      webEnv,
    );
    expect(Array.isArray(listed.tabs)).toBe(true);
    const ids = (listed.tabs ?? []).map((t) => t.id);
    expect(ids).toContain(first.id);
    expect(ids).toContain(secondId);
    expect(ids.length).toBe(2);

    // tab.switch — focus the first tab again.
    const switched = await executeBrowserWorkspaceCommand(
      { subaction: "tab", tabAction: "switch", id: first.id },
      webEnv,
    );
    expect(switched.tab?.id).toBe(first.id);
    expect(switched.tab?.visible).toBe(true);

    // tab.close — close the second tab.
    const closed = await executeBrowserWorkspaceCommand(
      { subaction: "tab", tabAction: "close", id: secondId },
      webEnv,
    );
    expect(closed.closed).toBeTruthy();

    // tab.list — only the first tab remains.
    const remaining = await executeBrowserWorkspaceCommand(
      { subaction: "tab", tabAction: "list" },
      webEnv,
    );
    const remainingIds = (remaining.tabs ?? []).map((t) => t.id);
    expect(remainingIds).toEqual([first.id]);
  });

  it("rejects switching to a tab that does not exist", async () => {
    await openBrowserWorkspaceTab({ url: "about:blank" }, webEnv);
    await expect(
      executeBrowserWorkspaceCommand(
        { subaction: "tab", tabAction: "switch", id: "btab_does_not_exist" },
        webEnv,
      ),
    ).rejects.toThrow(/valid id or index/i);
  });

  it("reports state for an about:blank tab without throwing on opaque-origin storage", async () => {
    const tab = await openBrowserWorkspaceTab({ url: "about:blank" }, webEnv);
    const state = await executeBrowserWorkspaceCommand(
      { subaction: "state", tabId: tab.id },
      webEnv,
    );
    expect(state.mode).toBe("web");
    const value = state.value as {
      url?: string;
      localStorage?: Record<string, string>;
      sessionStorage?: Record<string, string>;
    };
    expect(value.url).toBe("about:blank");
    // Opaque origin → storage degrades to empty maps rather than crashing.
    expect(value.localStorage).toEqual({});
    expect(value.sessionStorage).toEqual({});
  });

  it("surfaces a clear error for an explicit storage query on about:blank", async () => {
    const tab = await openBrowserWorkspaceTab({ url: "about:blank" }, webEnv);
    await expect(
      executeBrowserWorkspaceCommand(
        { subaction: "storage", tabId: tab.id, storageAction: "get" },
        webEnv,
      ),
    ).rejects.toThrow(/storage is unavailable/i);
  });
});
