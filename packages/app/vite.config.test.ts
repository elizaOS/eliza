/** Verifies app-shell WebSocket origins for dev proxies and native remotes. */

import { describe, expect, mock, test } from "bun:test";
import { runInNewContext } from "node:vm";
import appViteConfig, {
  appDevWsBasePlugin,
  resolveAppShellLocalCspSources,
  resolveDevApiProxyAuthority,
  rewriteSameOriginDevProxyOrigin,
} from "./vite.config";

describe("appDevWsBasePlugin", () => {
  test("injects same-origin ws/wss bases without a machine-local address", () => {
    const transform = appDevWsBasePlugin().transformIndexHtml;
    if (typeof transform !== "function") {
      throw new Error("dev WS plugin has no HTML transform");
    }

    const tags = transform("", {
      path: "/",
      filename: "index.html",
    }) as Array<{
      children?: string;
    }>;
    const script = tags[0]?.children;
    expect(script).toContain("location.protocol==='https:'?'wss://':'ws://'");
    expect(script).toContain("location.host");
    expect(script).toContain("window.__ELIZA_WS_BASE__");
    expect(script).toContain("window.__ELIZAOS_WS_BASE__");
    expect(script).not.toMatch(/127\.0\.0\.1|localhost|2138|31337/);

    for (const [protocol, expected] of [
      ["http:", "ws://tunnel.example:5175"],
      ["https:", "wss://tunnel.example:5175"],
    ]) {
      const window = {} as Record<string, string>;
      runInNewContext(script, {
        window,
        location: { protocol, host: "tunnel.example:5175" },
      });
      expect(window.__ELIZA_WS_BASE__).toBe(expected);
      expect(window.__ELIZAOS_WS_BASE__).toBe(expected);
      expect(window.__ELIZA_WS_BASE__).toBe(expected);
    }
  });
});

describe("app shell local connection policy", () => {
  test("preserves the browser authority through the local API proxy", () => {
    if (typeof appViteConfig !== "function") {
      throw new Error("app Vite config is not callable");
    }
    const config = appViteConfig({
      command: "serve",
      mode: "test",
      isSsrBuild: false,
      isPreview: false,
    });
    if (config instanceof Promise) {
      throw new Error("app Vite config unexpectedly became async");
    }
    const apiProxy = config.server?.proxy?.["/api"];
    if (typeof apiProxy !== "object" || apiProxy === null) {
      throw new Error("local /api proxy is missing");
    }

    expect(apiProxy.changeOrigin).toBe(false);
  });

  test("permits paired Android transports whose private-LAN host is selected at runtime", () => {
    expect(resolveAppShellLocalCspSources("android", false)).toEqual({
      localHttpSources: " http://localhost:* http://127.0.0.1:*",
      localConnectSources: " http: ws:",
    });
  });

  test("allows an owner-selected LAN WebSocket outside iOS store builds", () => {
    const sources = resolveAppShellLocalCspSources("ios", false);

    expect(sources.localConnectSources).toContain("ws:");
    expect(sources.localConnectSources).toContain("http://localhost:*");
    expect(sources.localConnectSources).toContain("http://127.0.0.1:*");
  });

  test("keeps cleartext local transports out of iOS store builds", () => {
    expect(resolveAppShellLocalCspSources("ios", true)).toEqual({
      localHttpSources: "",
      localConnectSources: "",
    });
  });
});

describe("development API proxy origin", () => {
  test("uses the matching authority policy for browser and native desktop dev", () => {
    expect(resolveDevApiProxyAuthority()).toEqual({
      changeOrigin: false,
      xfwd: true,
    });
    expect(resolveDevApiProxyAuthority("http://127.0.0.1:2338")).toEqual({
      changeOrigin: true,
      xfwd: false,
    });
  });

  test("normalizes only a same-origin Vite request to the local API", () => {
    const setHeader = mock(() => undefined);
    expect(
      rewriteSameOriginDevProxyOrigin(
        { setHeader },
        {
          headers: {
            host: "127.0.0.1:2563",
            origin: "http://127.0.0.1:2563",
          },
        },
        "http://127.0.0.1:32637",
      ),
    ).toBe(true);
    expect(setHeader).toHaveBeenCalledWith("Origin", "http://127.0.0.1:32637");
    expect(setHeader).toHaveBeenCalledWith("Sec-Fetch-Site", "same-origin");
  });

  test("preserves cross-origin and malformed origins for the API to reject", () => {
    for (const origin of ["https://attacker.example", "not a URL"]) {
      const setHeader = mock(() => undefined);
      expect(
        rewriteSameOriginDevProxyOrigin(
          { setHeader },
          { headers: { host: "127.0.0.1:2563", origin } },
          "http://127.0.0.1:32637",
        ),
      ).toBe(false);
      expect(setHeader).not.toHaveBeenCalled();
    }
  });

  test("recovers same-origin proof after proxy Host rewrite only on loopback", () => {
    const setHeader = mock(() => undefined);
    expect(
      rewriteSameOriginDevProxyOrigin(
        { setHeader },
        {
          headers: {
            host: "127.0.0.1:32637",
            origin: "http://127.0.0.1:2338",
          },
          socket: { remoteAddress: "::1" },
        },
        "http://127.0.0.1:32637",
        "http://127.0.0.1:2338",
      ),
    ).toBe(true);
    expect(setHeader).toHaveBeenCalledWith("Origin", "http://127.0.0.1:32637");

    const remoteSetHeader = mock(() => undefined);
    expect(
      rewriteSameOriginDevProxyOrigin(
        { setHeader: remoteSetHeader },
        {
          headers: {
            host: "127.0.0.1:32637",
            origin: "http://127.0.0.1:2338",
          },
          socket: { remoteAddress: "192.0.2.20" },
        },
        "http://127.0.0.1:32637",
        "http://127.0.0.1:2338",
      ),
    ).toBe(false);
    expect(remoteSetHeader).not.toHaveBeenCalled();
  });

  test("normalizes a same-origin browser GET referer when Origin is absent", () => {
    const setHeader = mock(() => undefined);
    expect(
      rewriteSameOriginDevProxyOrigin(
        { setHeader },
        {
          headers: {
            host: "127.0.0.1:32437",
            referer: "http://127.0.0.1:2338/workspace",
          },
          socket: { remoteAddress: "127.0.0.1" },
        },
        "http://127.0.0.1:32437",
        "http://127.0.0.1:2338",
      ),
    ).toBe(true);
    expect(setHeader).toHaveBeenCalledWith(
      "Referer",
      "http://127.0.0.1:32437/",
    );
    expect(setHeader).toHaveBeenCalledWith("Sec-Fetch-Site", "same-origin");
    expect(setHeader).not.toHaveBeenCalledWith(
      "Origin",
      "http://127.0.0.1:32437",
    );
  });
});
