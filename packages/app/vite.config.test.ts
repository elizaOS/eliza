/** Verifies app-shell WebSocket origins for dev proxies and native remotes. */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import appViteConfig, {
  ANDROID_CLOUD_FORBIDDEN_ROUTING_MARKERS,
  androidCloudCuratedAssetsPlugin,
  androidCloudRendererEntryPlugin,
  appDevWsBasePlugin,
  appShellMetadataPlugin,
  devViewStudioPlugin,
  findAndroidCloudEmittedRoutingFindings,
  resolveAndroidCloudPrebootLockupDataUri,
  resolveAppShellLocalCspSources,
  resolveLocalRealtimeVoiceDefines,
  resolveLocalRealtimeVoiceDefinesFromEnv,
  selectAndroidCloudRendererEntry,
  stripAndroidCloudIpcBootstrap,
  stripAndroidCloudPublicAssetReferences,
} from "./vite.config";

const testDir = path.dirname(fileURLToPath(import.meta.url));

describe("devViewStudioPlugin", () => {
  test("serves review assets only through the dev server", () => {
    expect(
      existsSync(path.join(testDir, "public", "eliza-view-studio.html")),
    ).toBe(false);
    expect(
      existsSync(path.join(testDir, "public", "eliza-proposed-theme.css")),
    ).toBe(false);

    let middleware:
      | ((
          req: { url?: string },
          res: {
            setHeader: (name: string, value: string) => void;
            end: (body: Buffer) => void;
          },
          next: () => void,
        ) => void)
      | undefined;
    const plugin = devViewStudioPlugin();
    expect(plugin.apply).toBe("serve");
    if (typeof plugin.configureServer !== "function") {
      throw new Error("view studio dev middleware is missing");
    }
    plugin.configureServer({
      middlewares: {
        use: (handler: typeof middleware) => (middleware = handler),
      },
    } as never);

    const headers = new Map<string, string>();
    let body: Buffer | undefined;
    let nextCalled = false;
    middleware?.(
      { url: "/eliza-view-studio.html?view=%2Fnotes" },
      {
        setHeader: (name, value) => headers.set(name, value),
        end: (value) => (body = value),
      },
      () => (nextCalled = true),
    );

    expect(nextCalled).toBe(false);
    expect(headers.get("Cache-Control")).toBe("no-store");
    expect(body?.toString()).toContain("Eliza View Studio");

    headers.clear();
    body = undefined;
    middleware?.(
      { url: "/eliza-proposed-theme.css" },
      {
        setHeader: (name, value) => headers.set(name, value),
        end: (value) => (body = value),
      },
      () => (nextCalled = true),
    );

    expect(headers.get("Content-Type")).toBe("text/css; charset=utf-8");
    expect(headers.get("Cache-Control")).toBe("no-store");
    expect(body?.toString()).toContain("data-eliza-studio-proposed");
  });
});

describe("local realtime voice defaults", () => {
  test("enables realtime and health-probed self-hosted eligibility without force-arming", () => {
    expect(resolveLocalRealtimeVoiceDefines("serve", 31_338, {})).toEqual({
      "import.meta.env.VITE_VOICE_REALTIME_WS": JSON.stringify("1"),
      "import.meta.env.VITE_VOICE_REALTIME_SELF_HOSTED": JSON.stringify("1"),
    });
  });

  test("preserves explicit client flag values", () => {
    expect(
      resolveLocalRealtimeVoiceDefines("serve", 31_338, {
        VITE_VOICE_REALTIME_WS: "0",
        VITE_VOICE_REALTIME_SELF_HOSTED: "false",
        VITE_VOICE_REALTIME_FORCE: "false",
      }),
    ).toEqual({});
    expect(
      resolveLocalRealtimeVoiceDefines("serve", 31_338, {
        VITE_VOICE_REALTIME_WS: "1",
        VITE_VOICE_REALTIME_SELF_HOSTED: "1",
      }),
    ).toEqual({});
  });

  test("defaults only a missing flag when the other has an explicit opt-out", () => {
    expect(
      resolveLocalRealtimeVoiceDefines("serve", 31_338, {
        VITE_VOICE_REALTIME_WS: "0",
      }),
    ).toEqual({
      "import.meta.env.VITE_VOICE_REALTIME_SELF_HOSTED": JSON.stringify("1"),
    });
    expect(
      resolveLocalRealtimeVoiceDefines("serve", 31_338, {
        VITE_VOICE_REALTIME_SELF_HOSTED: "0",
      }),
    ).toEqual({
      "import.meta.env.VITE_VOICE_REALTIME_WS": JSON.stringify("1"),
    });
  });

  test("does not change builds or dev servers without a gateway", () => {
    expect(resolveLocalRealtimeVoiceDefines("build", 31_338, {})).toEqual({});
    expect(resolveLocalRealtimeVoiceDefines("serve", null, {})).toEqual({});
  });

  test("preserves explicit opt-outs loaded from .env.local", () => {
    const envDir = mkdtempSync(path.join(os.tmpdir(), "eliza-voice-env-"));
    const previousWs = process.env.VITE_VOICE_REALTIME_WS;
    const previousSelfHosted = process.env.VITE_VOICE_REALTIME_SELF_HOSTED;
    const previousForce = process.env.VITE_VOICE_REALTIME_FORCE;
    delete process.env.VITE_VOICE_REALTIME_WS;
    delete process.env.VITE_VOICE_REALTIME_SELF_HOSTED;
    delete process.env.VITE_VOICE_REALTIME_FORCE;

    try {
      writeFileSync(
        path.join(envDir, ".env.local"),
        "VITE_VOICE_REALTIME_WS=0\nVITE_VOICE_REALTIME_SELF_HOSTED=false\nVITE_VOICE_REALTIME_FORCE=false\n",
      );
      expect(
        resolveLocalRealtimeVoiceDefinesFromEnv(
          "serve",
          "development",
          31_338,
          envDir,
        ),
      ).toEqual({});
    } finally {
      if (previousWs === undefined) {
        delete process.env.VITE_VOICE_REALTIME_WS;
      } else {
        process.env.VITE_VOICE_REALTIME_WS = previousWs;
      }
      if (previousSelfHosted === undefined) {
        delete process.env.VITE_VOICE_REALTIME_SELF_HOSTED;
      } else {
        process.env.VITE_VOICE_REALTIME_SELF_HOSTED = previousSelfHosted;
      }
      if (previousForce === undefined) {
        delete process.env.VITE_VOICE_REALTIME_FORCE;
      } else {
        process.env.VITE_VOICE_REALTIME_FORCE = previousForce;
      }
      rmSync(envDir, { recursive: true, force: true });
    }
  });
});

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
  test("emits manifest icon URLs that resolve to shipped public assets", () => {
    const emitted: Array<{ fileName?: string; source?: string | Uint8Array }> =
      [];
    const hook = appShellMetadataPlugin().generateBundle;
    if (typeof hook !== "function") {
      throw new Error("app metadata plugin has no bundle hook");
    }
    Reflect.apply(
      hook,
      {
        emitFile(asset: (typeof emitted)[number]) {
          emitted.push(asset);
          return asset.fileName ?? "emitted-asset";
        },
      },
      [],
    );

    const manifestAsset = emitted.find(
      (asset) => asset.fileName === "site.webmanifest",
    );
    const manifest = JSON.parse(String(manifestAsset?.source)) as {
      icons: Array<{ src: string }>;
    };
    expect(manifest.icons.map((icon) => icon.src)).toEqual([
      "/brand/favicons/android-chrome-192x192.png",
      "/brand/favicons/android-chrome-512x512.png",
    ]);
    for (const icon of manifest.icons) {
      expect(existsSync(join(import.meta.dir, "public", icon.src))).toBe(true);
    }
  });

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
  });

  test("packages third-party notices with the curated Android cloud assets", () => {
    if (typeof appViteConfig !== "function") {
      throw new Error("app Vite config is not callable");
    }
    const config = appViteConfig({
      command: "build",
      mode: "test",
      isSsrBuild: false,
      isPreview: false,
    });
    if (config instanceof Promise) {
      throw new Error("app Vite config unexpectedly became async");
    }
    expect(
      config.plugins?.some(
        (plugin) =>
          typeof plugin === "object" &&
          plugin !== null &&
          "name" in plugin &&
          plugin.name === "android-cloud-curated-assets",
      ),
    ).toBe(true);

    const emitted: Array<{
      type?: string;
      fileName?: string;
      source?: string | Uint8Array;
    }> = [];
    const hook = androidCloudCuratedAssetsPlugin(true).generateBundle;
    if (typeof hook !== "function") {
      throw new Error("Android Cloud curated-assets plugin has no bundle hook");
    }
    Reflect.apply(
      hook,
      {
        emitFile(asset: (typeof emitted)[number]) {
          emitted.push(asset);
          return asset.fileName ?? "emitted-asset";
        },
      },
      [{}, {}, false],
    );

    const notice = emitted.find(
      (asset) => asset.fileName === "THIRD_PARTY_NOTICES.txt",
    );

    expect(notice?.type).toBe("asset");
    const noticeText = Buffer.from(notice?.source ?? "").toString("utf8");
    expect(noticeText).toContain("Ionicons");
    expect(noticeText).toContain("MIT License");
  });

  test("audits every emitted file without rewriting packaged code", () => {
    const lazyCode =
      "remote-mac eliza-local-agent: http://127.0.0.1:31337 adb reverse tcp:32437";
    const bundle = {
      "entry.js": {
        type: "chunk" as const,
        isEntry: true,
        imports: ["runtime.js"],
        code: 'import "./runtime.js"',
      },
      "runtime.js": {
        type: "chunk" as const,
        imports: [],
        code: "const emulatorHost = '10.0.2.2'",
      },
      "lazy-direct-runtime.js": {
        type: "chunk" as const,
        imports: [],
        code: lazyCode,
      },
      "sw-registration.js": {
        type: "chunk" as const,
        imports: [],
        code: 'navigator.serviceWorker.register("/sw.js")',
      },
    };

    expect(findAndroidCloudEmittedRoutingFindings(bundle)).toEqual([
      "lazy-direct-runtime.js: 32437",
      "lazy-direct-runtime.js: adb reverse",
      "runtime.js: 10.0.2.2",
      "sw-registration.js: navigator.serviceWorker",
    ]);
    expect(bundle["lazy-direct-runtime.js"].code).toBe(lazyCode);
    expect(ANDROID_CLOUD_FORBIDDEN_ROUTING_MARKERS).toContain("adb reverse");
  });

  test("physically removes the native local-agent bootstrap from Android cloud HTML", () => {
    const source = `
      <head>
        <!-- ELIZA_NATIVE_AGENT_IPC_BRIDGE_START -->
        <script>window.__ELIZA_ANDROID_IPC_FETCH_BRIDGE__ = true; fetch("eliza-local-agent://ipc")</script>
        <!-- ELIZA_NATIVE_AGENT_IPC_BRIDGE_END -->
        <meta http-equiv="Content-Security-Policy" content="connect-src 'self' blob: data: eliza-local-agent: https://*;" />
      </head>
      <script type="module" src="/src/entry.ts"></script>`;
    const stripped = stripAndroidCloudIpcBootstrap(source);
    expect(stripped).not.toContain("ELIZA_ANDROID_IPC_FETCH_BRIDGE");
    expect(stripped).not.toContain("eliza-local-agent:");

    const plugin = appShellMetadataPlugin({
      androidCloudBuild: true,
      capacitorBuildTarget: "android",
    });
    if (typeof plugin.transformIndexHtml !== "function") {
      throw new Error("app metadata plugin has no HTML transform");
    }
    const transformed = plugin.transformIndexHtml(source) as string;
    expect(transformed).not.toContain("ELIZA_ANDROID_IPC_FETCH_BRIDGE");
    expect(transformed).not.toContain("eliza-local-agent:");
  });

  test("removes browser-only public asset references from the Play shell", () => {
    const source = `
      <link rel="icon" href="/brand/favicons/favicon.svg" />
      <link rel="apple-touch-icon" href="/brand/favicons/apple-touch-icon.png" />
      <link rel="manifest" href="/site.webmanifest" />
      <img class="eliza-preboot-shell__mark" src="/brand/logos/logo_white_nobg.svg" alt="" />
      <link rel="stylesheet" href="/assets/app.css" />`;
    const stripped = stripAndroidCloudPublicAssetReferences(source);

    expect(stripped).not.toMatch(
      /favicon|apple-touch-icon|site\.webmanifest|logo_white_nobg/,
    );
    expect(stripped).toContain('rel="stylesheet"');
  });

  test("inlines the complete Play preboot lockup as one atomic image", () => {
    const source = `
      <div class="eliza-preboot-shell__brand" aria-hidden="true">
        <img class="eliza-preboot-shell__mark" src="/brand/logos/logo_white_nobg.svg" alt="" />
        <span class="eliza-preboot-shell__name">elizaOS</span>
      </div>`;
    const stripped = stripAndroidCloudPublicAssetReferences(source);

    expect(stripped).toContain(
      'class="eliza-preboot-shell__lockup" src="data:image/svg+xml;base64,',
    );
    expect(stripped).toContain('decoding="sync" fetchpriority="high"');
    const encodedLockup = stripped.match(
      /src="data:image\/svg\+xml;base64,([^"]+)"/,
    )?.[1];
    expect(encodedLockup).toBeDefined();
    const lockupSvg = Buffer.from(encodedLockup ?? "", "base64").toString(
      "utf8",
    );
    expect(lockupSvg).toContain('fill="none"');
    expect(lockupSvg).toContain('fill="white"');
    expect(lockupSvg).not.toContain("#FF5800");
    expect(lockupSvg).not.toContain(
      '<rect x="0.081543" y="1.84143" width="101.919" height="101.919"',
    );
    expect(stripped).not.toContain("eliza-preboot-shell__name");
    expect(stripped).not.toContain("logo_white_nobg.svg");
  });

  test("does not resolve the Play-only lockup for non-Cloud renderers", () => {
    let resolutions = 0;
    const plugin = appShellMetadataPlugin({
      androidCloudBuild: false,
      capacitorBuildTarget: "android",
      resolveAndroidCloudPrebootLockup: () => {
        resolutions += 1;
        throw new Error("Cloud-only logo must stay lazy");
      },
    });
    if (typeof plugin.transformIndexHtml !== "function") {
      throw new Error("app metadata plugin has no HTML transform");
    }

    expect(plugin.transformIndexHtml("<main>direct Android</main>")).toContain(
      "direct Android",
    );
    expect(resolutions).toBe(0);
    expect(resolveAndroidCloudPrebootLockupDataUri()).toStartWith(
      "data:image/svg+xml;base64,",
    );
  });

  test("keeps the canonical renderer for Android Cloud builds", () => {
    const source = '<script type="module" src="/src/entry.ts"></script>';

    expect(selectAndroidCloudRendererEntry(source, true)).toBe(source);
    expect(selectAndroidCloudRendererEntry(source, false)).toBe(source);
    expect(() =>
      selectAndroidCloudRendererEntry("<main></main>", true),
    ).toThrow("missing the expected /src/entry.ts");

    const hook = androidCloudRendererEntryPlugin(true).transformIndexHtml;
    if (typeof hook !== "object" || !("handler" in hook)) {
      throw new Error("Android Cloud entry plugin has no pre-transform");
    }
    expect(hook.order).toBe("pre");
    const transformed = hook.handler(source, {
      path: "/",
      filename: "index.html",
      server: undefined,
      bundle: undefined,
      chunk: undefined,
      originalUrl: "/",
    }) as string;
    expect(transformed).toBe(source);
  });

  test("retains the native local-agent bootstrap outside Android cloud builds", () => {
    const source = `
      <!-- ELIZA_NATIVE_AGENT_IPC_BRIDGE_START -->
      <script>fetch("eliza-local-agent://ipc")</script>
      <!-- ELIZA_NATIVE_AGENT_IPC_BRIDGE_END -->`;
    const plugin = appShellMetadataPlugin({
      androidCloudBuild: false,
      capacitorBuildTarget: "android",
    });
    if (typeof plugin.transformIndexHtml !== "function") {
      throw new Error("app metadata plugin has no HTML transform");
    }
    expect(plugin.transformIndexHtml(source)).toContain(
      "eliza-local-agent://ipc",
    );
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
