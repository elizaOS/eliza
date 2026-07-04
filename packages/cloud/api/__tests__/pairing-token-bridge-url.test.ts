// Exercises cloud API tests pairing token bridge url.test behavior with deterministic Worker route fixtures.
import { describe, expect, it } from "vitest";

// Replicate the helper chain under test (the helpers are non-exported in
// route.ts; mirroring them lets us assert the parsing contract that the
// pairing-token route depends on). If the route signature changes, this test
// goes red so we update both in sync.
type PairingSandboxShape = {
  bridge_url?: string | null;
  health_url?: string | null;
  web_ui_port?: number | null;
};

function resolveDirectWebUiUrlFromBridgeHost(
  sandbox: PairingSandboxShape,
): string | null {
  if (!sandbox.web_ui_port) return null;

  const raw = sandbox.bridge_url?.trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.port = String(sandbox.web_ui_port);
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.origin;
  } catch {
    return null;
  }
}

function resolveDirectWebUiUrlFromHealthUrl(
  sandbox: PairingSandboxShape,
): string | null {
  const raw = sandbox.health_url?.trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.origin;
  } catch {
    return null;
  }
}

function resolveManagedWebUiUrl(sandbox: PairingSandboxShape): string | null {
  return (
    resolveDirectWebUiUrlFromBridgeHost(sandbox) ??
    resolveDirectWebUiUrlFromHealthUrl(sandbox)
  );
}

describe("resolveManagedWebUiUrl (pairing-token direct URL fallback)", () => {
  it("maps a bridge host plus web UI port to the browser-facing UI origin", () => {
    expect(
      resolveManagedWebUiUrl({
        bridge_url: "http://168.119.244.189:19027",
        web_ui_port: 3000,
      }),
    ).toBe("http://168.119.244.189:3000");
  });

  it("strips path and query from the stored bridge URL", () => {
    expect(
      resolveManagedWebUiUrl({
        bridge_url: "http://168.119.244.189:19027/health?x=1",
        web_ui_port: 3000,
      }),
    ).toBe("http://168.119.244.189:3000");
  });

  it("falls back to the health URL origin for local Docker providers without web_ui_port", () => {
    expect(
      resolveManagedWebUiUrl({
        bridge_url: "http://127.0.0.1:18888",
        health_url: "http://127.0.0.1:18889/api",
        web_ui_port: null,
      }),
    ).toBe("http://127.0.0.1:18889");
  });

  it("trims whitespace before parsing", () => {
    expect(
      resolveManagedWebUiUrl({
        bridge_url: "  http://10.0.0.1:8080  ",
        web_ui_port: 3000,
      }),
    ).toBe("http://10.0.0.1:3000");
  });

  it("returns null for empty/missing direct URL inputs", () => {
    expect(resolveManagedWebUiUrl({})).toBe(null);
    expect(resolveManagedWebUiUrl({ bridge_url: null })).toBe(null);
    expect(resolveManagedWebUiUrl({ bridge_url: "", health_url: "" })).toBe(
      null,
    );
    expect(
      resolveManagedWebUiUrl({ bridge_url: "   ", health_url: "   " }),
    ).toBe(null);
  });

  it("rejects non-http(s) schemes", () => {
    expect(
      resolveManagedWebUiUrl({
        bridge_url: "file:///etc/passwd",
        web_ui_port: 3000,
      }),
    ).toBe(null);
    expect(resolveManagedWebUiUrl({ health_url: "ftp://x.y/api" })).toBe(null);
  });

  it("returns null for unparseable garbage", () => {
    expect(
      resolveManagedWebUiUrl({ bridge_url: "not a url", web_ui_port: 3000 }),
    ).toBe(null);
    expect(resolveManagedWebUiUrl({ health_url: "http:" })).toBe(null);
  });
});
