// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { runDomAction } from "./dom-actions";
import { capturePageContext } from "./page-extract";
import { normalizeCompanionConfig } from "./storage";
import {
  findFocusedTab,
  mergeRememberedTabs,
  selectTabsForSync,
  type RememberedTab,
} from "./tab-cache";

describe("normalizeCompanionConfig", () => {
  it("returns null when companionId or pairingToken is missing", () => {
    expect(normalizeCompanionConfig(null)).toBeNull();
    expect(normalizeCompanionConfig({})).toBeNull();
    expect(
      normalizeCompanionConfig({ companionId: "abc" }),
    ).toBeNull();
    expect(
      normalizeCompanionConfig({ pairingToken: "lobr_1" }),
    ).toBeNull();
  });

  it("defaults apiBaseUrl to the loopback API port and strips trailing slashes", () => {
    const config = normalizeCompanionConfig({
      companionId: "abc",
      pairingToken: "lobr_xyz",
    });
    expect(config).not.toBeNull();
    expect(config?.apiBaseUrl).toBe("http://127.0.0.1:31337");
  });

  it("trims trailing slashes from apiBaseUrl", () => {
    const config = normalizeCompanionConfig({
      companionId: "abc",
      pairingToken: "lobr_xyz",
      apiBaseUrl: "https://milady.example.com/api///",
    });
    expect(config?.apiBaseUrl).toBe("https://milady.example.com/api");
  });

  it("coerces unknown browser values to chrome and preserves safari", () => {
    const chromeLike = normalizeCompanionConfig({
      companionId: "c",
      pairingToken: "t",
      browser: "firefox" as unknown as "chrome",
    });
    expect(chromeLike?.browser).toBe("chrome");

    const safari = normalizeCompanionConfig({
      companionId: "c",
      pairingToken: "t",
      browser: "safari",
    });
    expect(safari?.browser).toBe("safari");
  });

  it("auto-generates a label when none is provided", () => {
    const config = normalizeCompanionConfig({
      companionId: "c",
      pairingToken: "t",
      browser: "chrome",
      profileId: "work",
    });
    expect(config?.profileLabel).toBe("work");
    expect(config?.label).toBe("LifeOps Browser chrome work");
  });
});

const baseSettings = {
  enabled: true,
  trackingMode: "active_tabs" as const,
  allowBrowserControl: true,
  requireConfirmationForAccountAffecting: true,
  incognitoEnabled: false,
  siteAccessMode: "all_sites" as const,
  grantedOrigins: [],
  blockedOrigins: [],
  maxRememberedTabs: 5,
  pauseUntil: null,
  metadata: {},
  updatedAt: null,
};

function makeTab(
  overrides: Partial<RememberedTab> = {},
): RememberedTab {
  return {
    browser: "chrome",
    profileId: "default",
    windowId: "1",
    tabId: "100",
    url: "https://example.com/",
    title: "Example",
    activeInWindow: false,
    focusedWindow: false,
    focusedActive: false,
    incognito: false,
    faviconUrl: null,
    lastSeenAt: "2026-04-17T00:00:00.000Z",
    lastFocusedAt: null,
    metadata: {},
    ...overrides,
  };
}

describe("tab-cache", () => {
  it("findFocusedTab prefers focusedActive over activeInWindow", () => {
    const focused = makeTab({ tabId: "a", focusedActive: true });
    const active = makeTab({ tabId: "b", activeInWindow: true });
    const other = makeTab({ tabId: "c" });
    expect(findFocusedTab([other, active, focused])?.tabId).toBe("a");
    expect(findFocusedTab([other, active])?.tabId).toBe("b");
    expect(findFocusedTab([other])?.tabId).toBe("c");
    expect(findFocusedTab([])).toBeNull();
  });

  it("mergeRememberedTabs keeps previous lastFocusedAt when snapshot is null", () => {
    const prior = makeTab({ tabId: "x", lastFocusedAt: "2026-04-16T00:00:00.000Z" });
    const next = makeTab({ tabId: "x", lastFocusedAt: null });
    const merged = mergeRememberedTabs([prior], [next], 10);
    expect(merged[0].lastFocusedAt).toBe("2026-04-16T00:00:00.000Z");
  });

  it("mergeRememberedTabs marks closed tabs as inactive", () => {
    const prior = makeTab({
      tabId: "x",
      activeInWindow: true,
      focusedWindow: true,
      focusedActive: true,
    });
    const merged = mergeRememberedTabs([prior], [], 10);
    expect(merged[0].activeInWindow).toBe(false);
    expect(merged[0].focusedActive).toBe(false);
  });

  it("mergeRememberedTabs respects maxRememberedTabs", () => {
    const snapshot = [
      makeTab({ tabId: "1", activeInWindow: true }),
      makeTab({ tabId: "2" }),
      makeTab({ tabId: "3" }),
    ];
    const merged = mergeRememberedTabs([], snapshot, 2);
    expect(merged).toHaveLength(2);
    expect(merged[0].tabId).toBe("1");
  });

  it("selectTabsForSync returns [] when tracking is disabled", () => {
    const tabs = [makeTab({ focusedActive: true })];
    expect(
      selectTabsForSync({
        previous: [],
        snapshot: tabs,
        settings: { ...baseSettings, enabled: false },
        fallbackMaxRememberedTabs: 5,
      }),
    ).toEqual([]);
    expect(
      selectTabsForSync({
        previous: [],
        snapshot: tabs,
        settings: { ...baseSettings, trackingMode: "off" },
        fallbackMaxRememberedTabs: 5,
      }),
    ).toEqual([]);
  });

  it("selectTabsForSync respects pauseUntil in the future", () => {
    const pauseUntil = new Date(Date.now() + 60_000).toISOString();
    const tabs = [makeTab({ focusedActive: true })];
    expect(
      selectTabsForSync({
        previous: [],
        snapshot: tabs,
        settings: { ...baseSettings, pauseUntil },
        fallbackMaxRememberedTabs: 5,
      }),
    ).toEqual([]);
  });

  it("selectTabsForSync filters blocked origins", () => {
    const snapshot = [
      makeTab({ tabId: "1", url: "https://bad.example/", focusedActive: true }),
      makeTab({ tabId: "2", url: "https://good.example/", activeInWindow: true }),
    ];
    const selected = selectTabsForSync({
      previous: [],
      snapshot,
      settings: {
        ...baseSettings,
        blockedOrigins: ["https://bad.example"],
      },
      fallbackMaxRememberedTabs: 5,
    });
    expect(selected.map((tab) => tab.tabId)).toEqual(["2"]);
  });

  it("selectTabsForSync current_tab mode returns only focused tab", () => {
    const snapshot = [
      makeTab({ tabId: "1" }),
      makeTab({ tabId: "2", focusedActive: true }),
      makeTab({ tabId: "3", activeInWindow: true }),
    ];
    const selected = selectTabsForSync({
      previous: [],
      snapshot,
      settings: { ...baseSettings, trackingMode: "current_tab" },
      fallbackMaxRememberedTabs: 5,
    });
    expect(selected).toHaveLength(1);
    expect(selected[0].tabId).toBe("2");
  });

  it("selectTabsForSync granted_sites mode admits only allow-listed origins", () => {
    const snapshot = [
      makeTab({ tabId: "1", url: "https://listed.example/", focusedActive: true }),
      makeTab({ tabId: "2", url: "https://other.example/", activeInWindow: true }),
    ];
    const selected = selectTabsForSync({
      previous: [],
      snapshot,
      settings: {
        ...baseSettings,
        siteAccessMode: "granted_sites",
        grantedOrigins: ["https://listed.example"],
      },
      fallbackMaxRememberedTabs: 5,
    });
    expect(selected.map((tab) => tab.tabId)).toEqual(["1"]);
  });
});

describe("page-extract.capturePageContext", () => {
  beforeEach(() => {
    document.documentElement.innerHTML = "";
  });

  it("collects title, headings, links, and visible text", () => {
    document.title = "Unit Test Page";
    document.body.innerHTML = `
      <h1>Primary heading</h1>
      <h2>Sub heading</h2>
      <p>Some readable body text for the extraction test.</p>
      <a href="https://example.com/a">Alpha</a>
      <a href="https://example.com/b">Beta</a>
      <form action="https://example.com/post">
        <input name="search" type="text" />
        <input type="password" name="secret" />
      </form>
    `;
    const ctx = capturePageContext();
    expect(ctx.title).toBe("Unit Test Page");
    expect(ctx.headings).toContain("Primary heading");
    expect(ctx.headings).toContain("Sub heading");
    expect(ctx.links.map((link) => link.href)).toEqual(
      expect.arrayContaining([
        "https://example.com/a",
        "https://example.com/b",
      ]),
    );
    expect(ctx.forms).toHaveLength(1);
    expect(ctx.forms[0].fields).toContain("search");
    expect(ctx.forms[0].fields).not.toContain("secret");
    expect(ctx.mainText).toMatch(/readable body text/);
    expect(new Date(ctx.capturedAt).toString()).not.toBe("Invalid Date");
  });

  it("returns no main text when body is empty", () => {
    const ctx = capturePageContext();
    expect(ctx.mainText).toBeNull();
    expect(ctx.headings).toEqual([]);
    expect(ctx.links).toEqual([]);
    expect(ctx.forms).toEqual([]);
  });
});

describe("dom-actions.runDomAction", () => {
  beforeEach(() => {
    document.documentElement.innerHTML = "";
  });

  it("click requires a selector", () => {
    expect(() => runDomAction({ kind: "click" })).toThrow(
      /selector is required/,
    );
  });

  it("click invokes the element click handler", () => {
    const btn = document.createElement("button");
    btn.id = "go";
    let clicked = false;
    btn.addEventListener("click", () => {
      clicked = true;
    });
    document.body.appendChild(btn);
    const result = runDomAction({ kind: "click", selector: "#go" });
    expect(clicked).toBe(true);
    expect(result.selector).toBe("#go");
    expect(result.tagName).toBe("button");
  });

  it("type sets the value and fires input/change events", () => {
    const input = document.createElement("input");
    input.id = "q";
    input.name = "search";
    document.body.appendChild(input);
    const inputEvents: Event[] = [];
    input.addEventListener("input", (evt) => inputEvents.push(evt));
    input.addEventListener("change", (evt) => inputEvents.push(evt));
    const result = runDomAction({
      kind: "type",
      selector: "#q",
      text: "hello",
    });
    expect(input.value).toBe("hello");
    expect(inputEvents).toHaveLength(2);
    expect(result.valueLength).toBe(5);
  });

  it("type without text throws", () => {
    expect(() =>
      runDomAction({ kind: "type", selector: "#x" }),
    ).toThrow(/text is required/);
  });

  it("type rejects elements that do not support typing", () => {
    const span = document.createElement("span");
    span.id = "s";
    document.body.appendChild(span);
    expect(() =>
      runDomAction({ kind: "type", selector: "#s", text: "hi" }),
    ).toThrow(/does not support typing/);
  });

  it("submit resolves to closest form when selector points inside a form", () => {
    document.body.innerHTML = `
      <form action="https://example.com/go">
        <input id="q" name="q" />
        <button id="submit" type="submit">Go</button>
      </form>
    `;
    const form = document.querySelector("form")!;
    let submitted = false;
    form.addEventListener("submit", (evt) => {
      evt.preventDefault();
      submitted = true;
    });
    const result = runDomAction({ kind: "submit", selector: "#q" });
    expect(submitted).toBe(true);
    expect(result.action).toBe("https://example.com/go");
  });

  it("submit throws when no form is available", () => {
    expect(() => runDomAction({ kind: "submit" })).toThrow(
      /No form available/,
    );
  });

  it("history_back and history_forward return direction markers", () => {
    expect(runDomAction({ kind: "history_back" })).toEqual({
      direction: "back",
    });
    expect(runDomAction({ kind: "history_forward" })).toEqual({
      direction: "forward",
    });
  });

  it("rejects unknown action kinds", () => {
    expect(() =>
      runDomAction({
        kind: "telepathy" as unknown as "click",
      }),
    ).toThrow(/Unsupported DOM action/);
  });
});
