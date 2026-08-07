/** Verifies app-shell WebSocket origins for dev proxies and native remotes. */

import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import {
  appDevWsBasePlugin,
  resolveAppShellLocalCspSources,
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
