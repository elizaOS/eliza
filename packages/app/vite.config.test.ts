/** Verifies app-shell WebSocket origins for dev proxies and native remotes. */

import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import appViteConfig, {
  ANDROID_CLOUD_FORBIDDEN_ROUTING_MARKERS,
  appDevWsBasePlugin,
  resolveAppShellLocalCspSources,
  scrubAndroidCloudLocalRouting,
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

  test("keeps cleartext and local routing out of Android cloud builds", () => {
    expect(resolveAppShellLocalCspSources("android", false, true)).toEqual({
      localHttpSources: "",
      localConnectSources: "",
    });
    const scrubbed = scrubAndroidCloudLocalRouting(
      "http://127.0.0.1:31337 http://10.0.2.2:31338 adb reverse tcp:32437",
    );
    for (const marker of ANDROID_CLOUD_FORBIDDEN_ROUTING_MARKERS) {
      expect(scrubbed.toLowerCase()).not.toContain(marker.toLowerCase());
    }
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
