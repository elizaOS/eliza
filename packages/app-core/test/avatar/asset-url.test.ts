import { resolveApiUrl, resolveAppAssetUrl } from "@elizaos/app-core/utils";
import { describe, expect, it } from "vitest";

describe("resolveAppAssetUrl", () => {
  it("returns root-relative path when runtime URL context is unavailable", () => {
    expect(resolveAppAssetUrl("vrms/1.vrm")).toBe("/vrms/1.vrm");
    expect(resolveAppAssetUrl("/vrms/previews/milady-1.png")).toBe(
      "/vrms/previews/milady-1.png",
    );
  });

  it("passes through already-absolute URLs", () => {
    expect(resolveAppAssetUrl("blob:http://localhost/abc")).toBe(
      "blob:http://localhost/abc",
    );
    expect(resolveAppAssetUrl("data:text/plain,ok")).toBe("data:text/plain,ok");
    expect(resolveAppAssetUrl("https://cdn.example.com/a.vrm")).toBe(
      "https://cdn.example.com/a.vrm",
    );
  });

  it("resolves file:// assets relative to index directory", () => {
    const url = resolveAppAssetUrl("/vrms/1.vrm", {
      currentUrl:
        "file:///Users/tester/Milady.app/Contents/Resources/app/dist/index.html",
      baseUrl: "./",
    });
    expect(url).toBe(
      "file:///Users/tester/Milady.app/Contents/Resources/app/dist/vrms/1.vrm",
    );
  });

  it("resolves custom-scheme assets using base path", () => {
    const url = resolveAppAssetUrl("animations/idle.glb", {
      currentUrl: "electrobun://-/chat",
      baseUrl: "./",
    });
    expect(url).toBe("electrobun://-/animations/idle.glb");
  });
});

// ---------------------------------------------------------------------------
// resolveApiUrl()
// ---------------------------------------------------------------------------

describe("resolveApiUrl", () => {
  // resolveApiUrl checks `typeof window !== "undefined"`, so we must
  // define a minimal `window` on globalThis for the duration of each test.
  const g = globalThis as Record<string, unknown>;

  function withWindow(props: Record<string, unknown>, fn: () => void): void {
    const hadWindow = "window" in g;
    const savedWindow = g.window;
    g.window = { ...props };
    try {
      fn();
    } finally {
      if (hadWindow) {
        g.window = savedWindow;
      } else {
        delete g.window;
      }
    }
  }

  it("returns the path unchanged when window exists but __MILADY_API_BASE__ is not set", () => {
    withWindow({}, () => {
      expect(resolveApiUrl("/api/avatar/vrm")).toBe("/api/avatar/vrm");
    });
  });

  it("returns the path unchanged when window is undefined (SSR/Node)", () => {
    // In Node test env, window is already undefined — just call directly
    expect(resolveApiUrl("/api/avatar/vrm")).toBe("/api/avatar/vrm");
  });

  it("prefixes with __MILADY_API_BASE__ when set", () => {
    withWindow({ __MILADY_API_BASE__: "http://localhost:2138" }, () => {
      expect(resolveApiUrl("/api/avatar/vrm")).toBe(
        "http://localhost:2138/api/avatar/vrm",
      );
    });
  });

  it("handles empty string base gracefully (falsy → passthrough)", () => {
    withWindow({ __MILADY_API_BASE__: "" }, () => {
      expect(resolveApiUrl("/api/tts/elevenlabs")).toBe("/api/tts/elevenlabs");
    });
  });
});
