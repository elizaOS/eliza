/**
 * Browser workspace snapshot tests for HTML, text, and screenshot outputs.
 */

import { describe, expect, it } from "vitest";
import {
  diffBrowserWorkspaceSnapshots,
  escapeBrowserWorkspacePdfText,
  readBrowserWorkspaceCookies,
  readBrowserWorkspaceStorage,
} from "./browser-workspace-snapshots.js";
import type { BrowserWorkspaceSnapshotRecord } from "./browser-workspace-types.js";

/**
 * Browser-workspace snapshot helpers. PDF-text escaping must neutralize the
 * `\ ( )` metacharacters (avoids malformed/injected PDF content streams),
 * snapshot diffing flags any title/url/body change, and storage/cookie parsing
 * must round-trip key/value pairs from the DOM surfaces.
 */

describe("escapeBrowserWorkspacePdfText", () => {
  it("escapes backslash and parentheses", () => {
    expect(escapeBrowserWorkspacePdfText("a(b)c\\d")).toBe("a\\(b\\)c\\\\d");
    expect(escapeBrowserWorkspacePdfText("plain")).toBe("plain");
  });
});

describe("diffBrowserWorkspaceSnapshots", () => {
  const snap = (over: Partial<BrowserWorkspaceSnapshotRecord>) =>
    ({
      bodyText: "body",
      title: "Title",
      url: "https://x.com",
      ...over,
    }) as BrowserWorkspaceSnapshotRecord;

  it("flags changed when before is null or any field differs", () => {
    expect(diffBrowserWorkspaceSnapshots(null, snap({})).changed).toBe(true);
    expect(diffBrowserWorkspaceSnapshots(snap({}), snap({})).changed).toBe(
      false,
    );
    expect(
      diffBrowserWorkspaceSnapshots(snap({}), snap({ title: "New" })).changed,
    ).toBe(true);
    expect(
      diffBrowserWorkspaceSnapshots(snap({}), snap({ url: "https://y.com" }))
        .changed,
    ).toBe(true);
  });
});

describe("readBrowserWorkspaceStorage", () => {
  it("collects all key/value entries from a Storage", () => {
    const store: Record<string, string> = { a: "1", b: "2" };
    const keys = Object.keys(store);
    const storage = {
      length: keys.length,
      key: (i: number) => keys[i] ?? null,
      getItem: (k: string) => store[k] ?? null,
    } as unknown as Storage;
    expect(readBrowserWorkspaceStorage(storage)).toEqual({ a: "1", b: "2" });
  });
});

describe("readBrowserWorkspaceCookies", () => {
  it("parses a cookie string into key/value pairs", () => {
    expect(
      readBrowserWorkspaceCookies({ cookie: "a=1; b=2=3" } as Document),
    ).toEqual({ a: "1", b: "2=3" });
    expect(readBrowserWorkspaceCookies({ cookie: "" } as Document)).toEqual({});
  });
});
