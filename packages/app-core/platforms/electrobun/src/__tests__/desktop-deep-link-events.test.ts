import { describe, expect, it } from "vitest";
import {
  classifyDeepLinkRoute,
  readOpenUrlEventUrl,
} from "./desktop-deep-link-events.ts";

describe("readOpenUrlEventUrl", () => {
  it("reads string events", () => {
    expect(readOpenUrlEventUrl("https://a.com")).toBe("https://a.com");
    expect(readOpenUrlEventUrl("  https://a.com  ")).toBe("https://a.com");
    expect(readOpenUrlEventUrl("")).toBeNull();
    expect(readOpenUrlEventUrl("   ")).toBeNull();
  });

  it("reads url and data.url object forms", () => {
    expect(readOpenUrlEventUrl({ url: "https://a.com" })).toBe("https://a.com");
    expect(readOpenUrlEventUrl({ data: { url: "https://b.com" } })).toBe(
      "https://b.com",
    );
  });

  it("rejects malformed events", () => {
    expect(readOpenUrlEventUrl(null)).toBeNull();
    expect(readOpenUrlEventUrl(42)).toBeNull();
    expect(readOpenUrlEventUrl({})).toBeNull();
    expect(readOpenUrlEventUrl({ url: 5 })).toBeNull();
  });
});

describe("classifyDeepLinkRoute", () => {
  it("routes apps hosts to app windows", () => {
    expect(classifyDeepLinkRoute("elizaos://apps/plugin-viewer")).toEqual({
      kind: "app",
      slug: "plugin-viewer",
    });
  });

  it("normalizes host case (opaque host not lowercased by URL parser)", () => {
    expect(classifyDeepLinkRoute("ELIZAOS://Apps/plugin-viewer")).toEqual({
      kind: "app",
      slug: "plugin-viewer",
    });
  });

  it("forwards non-app links", () => {
    expect(classifyDeepLinkRoute("elizaos://agents/x")).toEqual({
      kind: "forward",
    });
    expect(classifyDeepLinkRoute("https://a.com/x")).toEqual({
      kind: "forward",
    });
  });

  it("forwards unparseable urls", () => {
    expect(classifyDeepLinkRoute("not a url")).toEqual({ kind: "forward" });
  });
});
