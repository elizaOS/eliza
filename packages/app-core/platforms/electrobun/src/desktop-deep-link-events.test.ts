/** Exercises desktop deep link events behavior with deterministic app-core test fixtures. */
import { describe, expect, it } from "vitest";
import {
  classifyDeepLinkRoute,
  readOpenUrlEventUrl,
} from "./desktop-deep-link-events";

describe("desktop deep-link events", () => {
  it("accepts direct open-url string payloads", () => {
    expect(readOpenUrlEventUrl(" elizaos://assistant?text=hello ")).toBe(
      "elizaos://assistant?text=hello",
    );
  });

  it("accepts object open-url payloads from desktop event bridges", () => {
    expect(
      readOpenUrlEventUrl({
        url: "elizaos://assistant?source=macos-shortcuts",
      }),
    ).toBe("elizaos://assistant?source=macos-shortcuts");
    expect(
      readOpenUrlEventUrl({
        data: { url: "elizaos://assistant?action=lifeops.create" },
      }),
    ).toBe("elizaos://assistant?action=lifeops.create");
  });

  it("rejects empty or malformed open-url events", () => {
    expect(readOpenUrlEventUrl(" ")).toBeNull();
    expect(readOpenUrlEventUrl({ url: "" })).toBeNull();
    expect(readOpenUrlEventUrl({ data: { url: 42 } })).toBeNull();
    expect(readOpenUrlEventUrl(null)).toBeNull();
  });
});

describe("classifyDeepLinkRoute (#10720)", () => {
  it("routes <scheme>://apps/<slug> to an app open", () => {
    expect(classifyDeepLinkRoute("elizaos://apps/plugin-viewer")).toEqual({
      kind: "app",
      slug: "plugin-viewer",
    });
  });

  it("is case-insensitive on the host (custom schemes don't lowercase it)", () => {
    // Regression: `new URL("elizaos://Apps/x").host === "Apps"` for opaque hosts,
    // so a case-sensitive check mis-forwarded a mixed-case authored link.
    expect(classifyDeepLinkRoute("ELIZAOS://Apps/plugin-viewer")).toEqual({
      kind: "app",
      slug: "plugin-viewer",
    });
    expect(classifyDeepLinkRoute("elizaos://APPS/wallet")).toEqual({
      kind: "app",
      slug: "wallet",
    });
  });

  it("takes only the first path segment as the slug", () => {
    expect(classifyDeepLinkRoute("elizaos://apps/wallet/inventory")).toEqual({
      kind: "app",
      slug: "wallet",
    });
  });

  it("forwards non-apps hosts, empty slugs, and unparseable urls", () => {
    expect(classifyDeepLinkRoute("elizaos://assistant?text=hi")).toEqual({
      kind: "forward",
    });
    expect(classifyDeepLinkRoute("elizaos://apps/")).toEqual({
      kind: "forward",
    });
    expect(classifyDeepLinkRoute("not a url")).toEqual({ kind: "forward" });
  });
});
