import { describe, expect, it } from "vitest";
import {
  BrowserTabSession,
  type BrowserTabState,
  newBrowserTabId,
  validBrowserTabId,
} from "./tab-host";

const S = "session-1";
let sequence = 0;
const state = (fields: Partial<BrowserTabState>): BrowserTabState => ({
  session: S,
  id: "t1",
  sequence: ++sequence,
  ...fields,
});
const committed = (fields: Partial<BrowserTabState> = {}) =>
  state({
    url: "https://example.test/a",
    navigation: "2",
    committed: true,
    loading: false,
    error: "",
    ...fields,
  });

async function session(
  privateTab = false,
  id = "t1",
): Promise<BrowserTabSession> {
  const tabs = new BrowserTabSession({ session: S });
  await tabs.ensure(id, privateTab, async () => undefined);
  return tabs;
}

describe("BrowserTabSession", () => {
  it("creates each native tab once and retries a failed creation", async () => {
    const tabs = new BrowserTabSession({ session: S, maxTabs: 2 });
    let calls = 0;
    const create = async () => {
      calls++;
      if (calls === 1) throw new Error("profile");
    };
    await expect(tabs.ensure("t1", false, create)).rejects.toThrow("profile");
    expect(tabs.has("t1")).toBe(false);
    await tabs.ensure("t1", false, create);
    await tabs.ensure("t1", false, create);
    expect(calls).toBe(2);
    await tabs.ensure("t2", true, create);
    expect(tabs.isPrivate("t2")).toBe(true);
    await expect(tabs.ensure("t3", false, create)).rejects.toThrow(
      "Close a tab",
    );
    await expect(tabs.ensure("../x", false, create)).rejects.toThrow(
      "Invalid tab",
    );
  });

  it("accepts only this session's events, in native order, for created tabs", async () => {
    const tabs = await session();
    expect(tabs.applyState({ ...committed(), session: "other" })).toBe(
      undefined,
    );
    expect(tabs.applyState(committed({ id: "unknown" }))).toBe(undefined);
    const first = committed();
    expect(tabs.applyState(first)?.committedPage).toBe(true);
    expect(tabs.applyState({ ...first, url: "https://late.test/" })).toBe(
      undefined,
    );
    expect(tabs.info("t1")?.url).toBe("https://example.test/a");
    expect(tabs.info("t1")?.savedUrl).toBe("https://example.test/a");
  });

  it("moves the document revision on a new address or a new load", async () => {
    const tabs = await session();
    tabs.applyState(committed());
    const r = tabs.revision("t1");
    expect(tabs.applyState(committed({ title: "T" }))?.revisionChanged).toBe(
      false,
    );
    expect(tabs.revision("t1")).toBe(r);
    const loading = tabs.applyState(committed({ loading: true }));
    expect(loading?.revisionChanged).toBe(true);
    expect(loading?.documentChanged).toBe(true);
    expect(loading?.committedPage).toBe(false);
    expect(tabs.revision("t1")).toBe(r + 1);
    tabs.applyState(committed({ url: "https://example.test/b" }));
    expect(tabs.revision("t1")).toBe(r + 2);
    expect(tabs.beginNavigation("t1", "https://example.test/c")).toBe(r + 3);
    expect(tabs.info("t1")).toMatchObject({ loading: true, committed: false });
  });

  it("binds a page only while the same settled document is selected", async () => {
    const tabs = await session();
    expect(tabs.pageBinding("t1")).toBe(undefined);
    tabs.applyState(committed());
    const binding = tabs.pageBinding("t1", { https: true });
    expect(binding).toMatchObject({
      id: "t1",
      url: "https://example.test/a",
      navigation: "2",
      private: false,
    });
    expect(tabs.current(binding, "t1")).toBe(true);
    expect(tabs.current(binding, "t2")).toBe(false);
    if (!binding) throw new Error("binding");
    expect(tabs.guard(binding)).toEqual({
      session: S,
      id: "t1",
      url: "https://example.test/a",
      navigation: "2",
    });
    // Another navigation of the same address still retires the binding.
    tabs.applyState(committed({ loading: true }));
    tabs.applyState(committed({ navigation: "3" }));
    expect(tabs.current(binding, "t1")).toBe(false);
    tabs.applyState(committed({ url: "http://plain.test/", navigation: "4" }));
    expect(tabs.pageBinding("t1", { https: true })).toBe(undefined);
    expect(tabs.pageBinding("t1")?.url).toBe("http://plain.test/");
    tabs.applyState(committed({ error: "Page could not load." }));
    expect(tabs.pageBinding("t1")).toBe(undefined);
  });

  it("never binds an external-only page and never saves it", async () => {
    const tabs = await session();
    const change = tabs.applyState(committed({ externalOnly: true }));
    expect(change?.committedPage).toBe(false);
    expect(tabs.info("t1")?.committed).toBe(false);
    expect(tabs.pageBinding("t1")).toBe(undefined);
  });

  it("keeps private pages out of history and pop-ups in their opener's privacy", async () => {
    const tabs = await session(true);
    expect(tabs.applyState(committed())?.committedPage).toBe(false);
    expect(tabs.pageBinding("t1")?.private).toBe(true);
    const popup = tabs.applyOpened({ session: S, id: "p1", opener: "t1" });
    expect(popup).toEqual({ id: "p1", private: true });
    expect(tabs.revision("p1")).toBe(1);
    expect(tabs.applyOpened({ session: S, id: "p1" })).toBe(undefined);
    expect(tabs.applyOpened({ session: "x", id: "p2" })).toBe(undefined);
    const normal = await session(false);
    expect(normal.applyOpened({ session: S, id: "p2", opener: "t1" })).toEqual({
      id: "p2",
      private: false,
    });
    expect(
      normal.applyOpened({ session: S, id: "p3", private: true })?.private,
    ).toBe(true);
  });

  it("forgets natively closed tabs and refuses everything after dispose", async () => {
    const tabs = await session();
    await tabs.ensure("t2", true, async () => undefined);
    tabs.applyState(committed());
    expect(tabs.applyClosed({ session: "x", id: "t1" })).toBe(undefined);
    expect(tabs.applyClosed({ session: S, id: "t1" })).toBe("t1");
    expect(tabs.has("t1")).toBe(false);
    expect(tabs.info("t1")).toBe(undefined);
    expect(tabs.applyState(committed())).toBe(undefined);
    expect(tabs.dispose()).toEqual(["t2"]);
    expect(tabs.closed).toBe(true);
    expect(tabs.applyOpened({ session: S, id: "p9" })).toBe(undefined);
    await expect(tabs.ensure("t3", false, async () => 1)).rejects.toThrow(
      "Browser closed",
    );
  });

  it("clamps find results to the open find bar's tab", async () => {
    const tabs = await session();
    expect(
      tabs.findResult(
        { session: S, id: "t1", index: 9, count: 3, done: true },
        "t1",
      ),
    ).toEqual({ cleared: false, index: 3, count: 3, done: true });
    expect(
      tabs.findResult({ session: S, id: "t1", index: 1, count: 1 }, "t2"),
    ).toBe(undefined);
    expect(
      tabs.findResult({ session: S, id: "t1", cleared: true }, "t1"),
    ).toEqual({ cleared: true });
    expect(
      tabs.findResult({ session: S, id: "t1", index: -4, count: 1e9 }, "t1"),
    ).toEqual({ cleared: false, index: 0, count: 100000, done: false });
    expect(
      tabs.notice({ session: S, id: "t1", message: "x".repeat(500) }),
    ).toHaveLength(200);
  });

  it("identifies the selected document without its address", async () => {
    const tabs = await session();
    expect(tabs.selection("t1")).toBe(undefined);
    tabs.applyState(committed());
    const selection = tabs.selection("t1");
    expect(selection).toEqual({
      kind: "browser-tab",
      id: `${S}:t1`,
      revision: String(tabs.revision("t1")),
    });
    expect(JSON.stringify(selection)).not.toContain("example.test");
  });

  it("validates tab ids like the native host", () => {
    expect(validBrowserTabId(newBrowserTabId())).toBe(true);
    expect(validBrowserTabId("a".repeat(81))).toBe(false);
    expect(validBrowserTabId("a b")).toBe(false);
  });
});
