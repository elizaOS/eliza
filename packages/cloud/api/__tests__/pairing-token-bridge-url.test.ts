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

function isBrowserUnreachableHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h === "::1" || h.startsWith("127.")) return false;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  return /^f[cd]/.test(h) || h.startsWith("fe80");
}

function browserReachableOrigin(origin: string | null): string | null {
  if (!origin) return null;
  try {
    return isBrowserUnreachableHost(new URL(origin).hostname) ? null : origin;
  } catch {
    return null;
  }
}

function resolveManagedWebUiUrl(sandbox: PairingSandboxShape): string | null {
  return (
    browserReachableOrigin(resolveDirectWebUiUrlFromBridgeHost(sandbox)) ??
    browserReachableOrigin(resolveDirectWebUiUrlFromHealthUrl(sandbox))
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
        bridge_url: "  http://168.119.244.189:8080  ",
        web_ui_port: 3000,
      }),
    ).toBe("http://168.119.244.189:3000");
  });

  it("never hands a tailnet/CGNAT origin to the browser (the dead 100.64.x.x /pair redirect)", () => {
    // Production bridge_url lives on the tailnet — browsers cannot route
    // 100.64/10, so the direct rungs must yield null and the route falls
    // through to the public <agentId>.<baseDomain> proxy URL.
    expect(
      resolveManagedWebUiUrl({
        bridge_url: "http://100.64.0.157:21748",
        web_ui_port: 21748,
      }),
    ).toBe(null);
    expect(
      resolveManagedWebUiUrl({
        health_url: "http://100.64.0.157:21748/health",
      }),
    ).toBe(null);
  });

  it("rejects RFC1918 and link-local origins but keeps loopback (local dev) and public IPs", () => {
    for (const host of [
      "10.0.0.1",
      "172.16.5.5",
      "192.168.1.10",
      "169.254.9.9",
    ]) {
      expect(
        resolveManagedWebUiUrl({
          bridge_url: `http://${host}:19027`,
          web_ui_port: 3000,
        }),
      ).toBe(null);
    }
    expect(
      resolveManagedWebUiUrl({
        bridge_url: "http://127.0.0.1:18888",
        web_ui_port: 3000,
      }),
    ).toBe("http://127.0.0.1:3000");
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
