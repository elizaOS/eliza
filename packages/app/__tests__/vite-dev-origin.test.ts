import { describe, expect, it } from "vitest";
import { resolveViteDevServerRuntime } from "./vite-dev-origin.ts";

describe("resolveViteDevServerRuntime", () => {
  it("falls back to uiPort with no env", () => {
    const r = resolveViteDevServerRuntime({}, 3000);
    expect(r.origin).toBeUndefined();
    expect(r.hmr.port).toBe(3000);
  });

  it("resolves an explicit origin and public port", () => {
    const r = resolveViteDevServerRuntime(
      { ELIZA_VITE_ORIGIN: "https://dev.example.com:5173" },
      3000,
    );
    expect(r.origin).toBe("https://dev.example.com:5173");
    expect(r.hmr.port).toBe(3000);
    expect(r.hmr.clientPort).toBe(5173);
    expect(r.hmr.protocol).toBe("wss");
  });

  it("uses branded prefix keys", () => {
    const r = resolveViteDevServerRuntime(
      { APP_VITE_ORIGIN: "http://localhost:8080" },
      3000,
      "APP",
    );
    expect(r.origin).toBe("http://localhost:8080");
    expect(r.hmr.protocol).toBe("ws");
  });

  it("uses loopback origin when enabled", () => {
    const r = resolveViteDevServerRuntime(
      { ELIZA_VITE_LOOPBACK_ORIGIN: "1" },
      4000,
    );
    expect(r.origin).toBe("http://127.0.0.1:4000");
    expect(r.hmr.host).toBe("127.0.0.1");
  });

  it("honors explicit hmr host", () => {
    const r = resolveViteDevServerRuntime(
      { ELIZA_HMR_HOST: "hmr.local" },
      3000,
    );
    expect(r.hmr.host).toBe("hmr.local");
  });

  it("rejects non-http origins", () => {
    const r = resolveViteDevServerRuntime(
      { ELIZA_VITE_ORIGIN: "ftp://bad.example.com" },
      3000,
    );
    expect(r.origin).toBeUndefined();
  });

  it("derives default ports for http/https origins without explicit port", () => {
    const http = resolveViteDevServerRuntime(
      { ELIZA_VITE_ORIGIN: "http://dev.example.com" },
      3000,
    );
    expect(http.hmr.clientPort).toBe(80);
    const https = resolveViteDevServerRuntime(
      { ELIZA_VITE_ORIGIN: "https://dev.example.com" },
      3000,
    );
    expect(https.hmr.clientPort).toBe(443);
  });
});
