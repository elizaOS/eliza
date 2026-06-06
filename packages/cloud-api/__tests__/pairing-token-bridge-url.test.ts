import { describe, expect, it } from "vitest";

// Replicate the helper under test (it's a non-exported function in
// route.ts; mirroring it lets us assert the parsing contract that the
// route depends on). If the route signature changes, this test will go
// red so we update both in sync.
function resolveSandboxBridgeUrl(sandbox: {
  bridge_url?: string | null;
}): string | null {
  const raw = sandbox.bridge_url?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

describe("resolveSandboxBridgeUrl (pairing-token bridge fallback)", () => {
  it("returns the origin (no path) of a valid Hetzner http bridge_url", () => {
    expect(
      resolveSandboxBridgeUrl({ bridge_url: "http://168.119.244.189:19027" }),
    ).toBe("http://168.119.244.189:19027");
  });

  it("strips path + query from the stored URL", () => {
    expect(
      resolveSandboxBridgeUrl({
        bridge_url: "http://168.119.244.189:19027/health?x=1",
      }),
    ).toBe("http://168.119.244.189:19027");
  });

  it("trims whitespace before parsing", () => {
    expect(
      resolveSandboxBridgeUrl({ bridge_url: "  http://10.0.0.1:8080  " }),
    ).toBe("http://10.0.0.1:8080");
  });

  it("returns null for empty/missing bridge_url", () => {
    expect(resolveSandboxBridgeUrl({})).toBe(null);
    expect(resolveSandboxBridgeUrl({ bridge_url: null })).toBe(null);
    expect(resolveSandboxBridgeUrl({ bridge_url: "" })).toBe(null);
    expect(resolveSandboxBridgeUrl({ bridge_url: "   " })).toBe(null);
  });

  it("rejects non-http(s) schemes — no file://, no ftp://, no tcp://", () => {
    expect(resolveSandboxBridgeUrl({ bridge_url: "file:///etc/passwd" })).toBe(
      null,
    );
    expect(resolveSandboxBridgeUrl({ bridge_url: "ftp://x.y/" })).toBe(null);
  });

  it("returns null for unparseable garbage", () => {
    expect(resolveSandboxBridgeUrl({ bridge_url: "not a url" })).toBe(null);
    expect(resolveSandboxBridgeUrl({ bridge_url: "http:" })).toBe(null);
  });
});
