import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { JSDOM } from "jsdom";
import { normalizeBrowserWorkspaceText } from "./browser-workspace-helpers.js";
import { fetchBrowserWorkspaceTrackedResponse } from "./browser-workspace-network.js";
import {
  browserWorkspaceClipboardText,
  getBrowserWorkspaceRuntimeState,
  getBrowserWorkspaceTimestamp,
  setBrowserWorkspaceClipboardText,
} from "./browser-workspace-state.js";
import type {
  BrowserWorkspaceRuntimeState,
  WebBrowserWorkspaceTabState,
} from "./browser-workspace-types.js";

let jsdomCtor: typeof import("jsdom").JSDOM | undefined;

/**
 * Locate jsdom's package.json on disk, then resolve its declared entry file from there.
 * Vitest workers run on Node; Node cannot resolve `jsdom` from workspace roots when
 * Bun hoists deps under node_modules/.bun, but requiring jsdom from its own package
 * directory still works.
 */
export function findJsdomPackageJsonPath(): string {
  const candidatesUnderBase = (base: string): string | undefined => {
    const rels = [
      path.join("node_modules", "jsdom", "package.json"),
      path.join("apps", "app", "node_modules", "jsdom", "package.json"),
    ];
    for (const rel of rels) {
      const full = path.join(base, rel);
      if (existsSync(full)) {
        return full;
      }
    }
    return undefined;
  };

  const walk = (start: string, maxDepth: number): string | undefined => {
    let dir = start;
    for (let depth = 0; depth < maxDepth; depth += 1) {
      const hit = candidatesUnderBase(dir);
      if (hit) {
        return hit;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    return undefined;
  };

  const fromSource = walk(path.dirname(fileURLToPath(import.meta.url)), 24);
  if (fromSource) {
    return fromSource;
  }
  const fromCwd = walk(process.cwd(), 16);
  if (fromCwd) {
    return fromCwd;
  }

  throw new Error(
    "Could not find jsdom on disk (install dependencies: jsdom is listed on @elizaos/agent and apps/app).",
  );
}

/** Lazy-load jsdom so importing this module does not require jsdom at parse time (Vitest / server tests). */
export function getJSDOMClass(): typeof import("jsdom").JSDOM {
  if (!jsdomCtor) {
    const jsdomPkg = findJsdomPackageJsonPath();
    const jsdomDir = path.dirname(jsdomPkg);
    const meta = JSON.parse(readFileSync(jsdomPkg, "utf8")) as {
      main?: string;
    };
    const mainRel = (meta.main ?? "./lib/api.js").replace(/^\.\//, "");
    const entry = path.join(jsdomDir, mainRel);
    const req = createRequire(jsdomPkg);
    const mod = req(entry) as { JSDOM: typeof import("jsdom").JSDOM };
    jsdomCtor = mod.JSDOM;
  }
  return jsdomCtor;
}

export function createEmptyWebBrowserWorkspaceDom(url: string): JSDOM {
  return new (getJSDOMClass())(
    '<!doctype html><html lang="en"><head><title>New Tab</title></head><body></body></html>',
    {
      pretendToBeVisual: true,
      url,
    },
  );
}

export function applyBrowserWorkspaceDomSettings(
  dom: JSDOM,
  state: BrowserWorkspaceRuntimeState,
): void {
  const viewport = state.settings.viewport;
  if (viewport) {
    Object.defineProperty(dom.window, "innerWidth", {
      configurable: true,
      value: viewport.width,
    });
    Object.defineProperty(dom.window, "innerHeight", {
      configurable: true,
      value: viewport.height,
    });
    Object.defineProperty(dom.window, "devicePixelRatio", {
      configurable: true,
      value: viewport.scale,
    });
  }

  Object.defineProperty(dom.window.navigator, "onLine", {
    configurable: true,
    get: () => !state.settings.offline,
  });

  if (state.settings.device) {
    Object.defineProperty(dom.window.navigator, "userAgent", {
      configurable: true,
      value: `ElizaBrowserWorkspace/${state.settings.device}`,
    });
  }

  const matchMedia = (query: string) => {
    const matches =
      query.includes("prefers-color-scheme") &&
      ((state.settings.media === "dark" && query.includes("dark")) ||
        (state.settings.media === "light" && query.includes("light")));
    return {
      addEventListener() {},
      addListener() {},
      dispatchEvent() {
        return true;
      },
      matches,
      media: query,
      onchange: null,
      removeEventListener() {},
      removeListener() {},
    };
  };
  Object.defineProperty(dom.window, "matchMedia", {
    configurable: true,
    value: matchMedia,
  });

  Object.defineProperty(dom.window.navigator, "clipboard", {
    configurable: true,
    value: {
      readText: async () => browserWorkspaceClipboardText,
      writeText: async (value: string) => {
        setBrowserWorkspaceClipboardText(String(value ?? ""));
      },
    },
  });

  Object.defineProperty(dom.window.navigator, "geolocation", {
    configurable: true,
    value: {
      getCurrentPosition: (success: (position: unknown) => void) => {
        const coords = state.settings.geo ?? { latitude: 0, longitude: 0 };
        success({
          coords: {
            accuracy: 1,
            latitude: coords.latitude,
            longitude: coords.longitude,
          },
          timestamp: Date.now(),
        });
      },
    },
  });
}

export function installBrowserWorkspaceWebRuntime(
  tab: WebBrowserWorkspaceTabState,
  dom: JSDOM,
): void {
  const state = getBrowserWorkspaceRuntimeState("web", tab.id);
  applyBrowserWorkspaceDomSettings(dom, state);

  Object.defineProperty(dom.window, "__elizaBrowserWorkspaceState", {
    value: state,
    writable: true,
    configurable: true,
  });

  const consoleTarget = dom.window.console as Console & Record<string, unknown>;
  if (!consoleTarget.__elizaWrapped) {
    for (const level of ["log", "info", "warn", "error"] as const) {
      consoleTarget[level] = (...args: unknown[]) => {
        state.consoleEntries.push({
          level,
          message: args
            .map((value) => normalizeBrowserWorkspaceText(value))
            .join(" "),
          timestamp: getBrowserWorkspaceTimestamp(),
        });
        return undefined;
      };
    }
    consoleTarget.__elizaWrapped = true;
  }

  dom.window.alert = (message?: string) => {
    state.dialog = {
      defaultValue: null,
      message: String(message ?? ""),
      open: true,
      type: "alert",
    };
  };
  dom.window.confirm = (message?: string) => {
    state.dialog = {
      defaultValue: null,
      message: String(message ?? ""),
      open: true,
      type: "confirm",
    };
    return false;
  };
  dom.window.prompt = (message?: string, defaultValue?: string) => {
    state.dialog = {
      defaultValue: defaultValue ?? null,
      message: String(message ?? ""),
      open: true,
      type: "prompt",
    };
    return null;
  };

  Object.defineProperty(dom.window, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const inputUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : typeof (input as Request).url === "string"
              ? (input as Request).url
              : String(input);
      return fetchBrowserWorkspaceTrackedResponse(
        state,
        new URL(inputUrl, tab.url).toString(),
        {
          ...init,
          headers:
            init?.headers ??
            ((input as Request).headers
              ? (input as Request).headers
              : undefined),
          method:
            init?.method ??
            (typeof (input as Request).method === "string"
              ? (input as Request).method
              : undefined),
        },
        "fetch",
      );
    },
  });
}

export function ensureBrowserWorkspaceDom(
  tab: WebBrowserWorkspaceTabState,
): JSDOM {
  if (tab.dom && tab.loadedUrl === tab.url) {
    return tab.dom;
  }

  throw new Error(
    `Browser workspace tab ${tab.id} is not loaded yet. Reload or inspect the page first.`,
  );
}
