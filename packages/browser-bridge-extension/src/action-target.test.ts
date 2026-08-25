/**
 * Adversarial tests ensure browser action authorization remains bound to the
 * exact tab and window later used by the extension API.
 */
import { describe, expect, it } from "vitest";
import { resolveBrowserActionTarget } from "./action-target";
import type { ExtensionTab, ExtensionWindow } from "./webextension";

const tabs: ExtensionTab[] = [
  { id: 11, windowId: 1, active: true, incognito: false },
  { id: 22, windowId: 2, active: true, incognito: true },
];
const windows: ExtensionWindow[] = [
  { id: 1, focused: true, incognito: false },
  { id: 2, focused: false, incognito: true },
];

function resolve(
  overrides: Partial<Parameters<typeof resolveBrowserActionTarget>[0]> = {},
) {
  return resolveBrowserActionTarget({
    actionKind: "open",
    currentTabId: null,
    tabs,
    windows,
    focusedTab: tabs[0] ?? null,
    ...overrides,
  });
}

describe("resolveBrowserActionTarget", () => {
  it("binds an open action to its explicit incognito destination window", () => {
    expect(resolve({ actionWindowId: "2" })).toEqual({
      tabId: null,
      windowId: 2,
      incognito: true,
      focusedActive: false,
    });
  });

  it("authorizes a same-window open against the currently focused site", () => {
    expect(resolve()).toMatchObject({
      windowId: 1,
      incognito: false,
      focusedActive: true,
    });
  });

  it("rejects a tab and window identity from different windows", () => {
    expect(() => resolve({ actionTabId: "11", actionWindowId: "2" })).toThrow(
      /does not belong to window 2/i,
    );
  });

  it("fails closed for malformed and stale browser identifiers", () => {
    expect(() => resolve({ actionWindowId: "2x" })).toThrow(
      /positive integer/i,
    );
    expect(() => resolve({ actionTabId: "999" })).toThrow(
      /no longer available/i,
    );
  });

  it("selects the active tab in an explicit window for non-open actions", () => {
    expect(resolve({ actionKind: "navigate", actionWindowId: "2" })).toEqual({
      tabId: 22,
      windowId: 2,
      incognito: true,
      focusedActive: false,
    });
  });

  it("does not fall back across windows when the destination has no tab", () => {
    expect(
      resolve({
        actionKind: "navigate",
        actionWindowId: "2",
        tabs: [tabs[0] as ExtensionTab],
      }),
    ).toMatchObject({ tabId: null, windowId: 2, incognito: true });
  });
});
