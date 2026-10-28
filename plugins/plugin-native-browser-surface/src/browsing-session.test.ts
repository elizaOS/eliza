/** Saved tabs and history: private tabs never persist and damaged rows never restore. */
import { describe, expect, it } from "vitest";

import {
  browsingSnapshot,
  normalizeBrowsing,
  restoreBrowsing,
  savedBrowserUrl,
} from "./browsing-session";

describe("saved browsing", () => {
  it("accepts only http(s) addresses without credentials, spaces or controls", () => {
    expect(savedBrowserUrl("https://example.com/a?b#c")).toBe(true);
    expect(savedBrowserUrl("http://127.0.0.1:8080/")).toBe(true);
    for (const value of [
      "https://user:pw@example.com/",
      "https://example.com/a b",
      "https://example.com/\u0007",
      "javascript:alert(1)",
      "file:///etc/hosts",
      `https://example.com/${"a".repeat(4096)}`,
      42,
    ])
      expect(savedBrowserUrl(value)).toBe(false);
  });

  it("drops invalid, duplicate and excess rows and keeps a valid selection only", () => {
    const record = normalizeBrowsing(
      {
        history: [
          "https://a.test/",
          "https://a.test/",
          "ftp://b.test/",
          "https://c.test/",
        ],
        tabs: [
          { id: "t1", url: "https://a.test/", title: "A\u0000title" },
          { id: "t1", url: "https://b.test/", title: "duplicate" },
          { id: "bad id", url: "https://b.test/", title: "x" },
          { id: "t2", url: "https://user@b.test/", title: "x" },
          { id: "t3", url: "https://c.test/" },
        ],
        cur: "t2",
      },
      { tabs: 8, history: 1, title: 200 },
    );
    expect(record).toEqual({
      history: ["https://a.test/"],
      tabs: [
        { id: "t1", url: "https://a.test/", title: "A title" },
        { id: "t3", url: "https://c.test/", title: "" },
      ],
      cur: "",
    });
    expect(normalizeBrowsing("damaged")).toEqual({
      history: [],
      tabs: [],
      cur: "",
    });
  });

  it("never saves a private tab or its page", () => {
    const pages: Record<string, { url: string; title: string }> = {
      n: { url: "https://normal.test/", title: "Normal" },
      p: { url: "https://private.test/", title: "Private" },
    };
    const snapshot = browsingSnapshot(
      {
        tabs: [{ id: "n" }, { id: "p", priv: true }, { id: "fresh" }],
        visits: ["https://normal.test/"],
        cur: "p",
      },
      (id) => pages[id],
    );
    expect(snapshot).toEqual({
      history: ["https://normal.test/"],
      tabs: [{ id: "n", url: "https://normal.test/", title: "Normal" }],
      cur: "",
    });
  });

  it("replaces only an untouched new tab and otherwise merges history", () => {
    const saved = {
      history: ["https://b.test/"],
      tabs: [
        { id: "t1", url: "https://a.test/", title: "A" },
        { id: "t2", url: "https://b.test/", title: "B" },
      ],
      cur: "t2",
    };
    expect(
      restoreBrowsing(saved, { visits: ["https://x.test/"] }, true),
    ).toEqual({
      visits: ["https://x.test/", "https://b.test/"],
      restored: saved.tabs,
      cur: "t2",
    });
    expect(restoreBrowsing(saved, { visits: [] }, false)).toEqual({
      visits: ["https://b.test/"],
      restored: [],
    });
    expect(
      restoreBrowsing({ ...saved, cur: "missing" }, { visits: [] }, true).cur,
    ).toBe("t1");
  });
});
