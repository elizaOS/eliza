import Module from "node:module";
import path from "node:path";
import { afterAll, afterEach, vi } from "vitest";
import {
  createMemoryStorage,
  hasStorageApi,
  suppressReactTestConsoleErrors,
} from "./helpers/browser-mocks";

const requireFromHere = Module.createRequire(import.meta.url);
const testRenderer = requireFromHere(
  "react-test-renderer",
) as typeof import("react-test-renderer");

const REACT_RESOLVE_PATCH_MARK = Symbol.for("elizaos.test.reactResolvePatched");
const ANCHOR_CLICK_PATCH_MARK = Symbol.for("elizaos.test.anchorClickPatched");
const JSDOM_EMIT_PATCH_MARK = Symbol.for("elizaos.test.jsdomEmitPatched");

type ResolveFilename = (
  request: string,
  parent: unknown,
  isMain: boolean,
  options: unknown,
) => string;

// ── React deduplication ──────────────────────────────────────────────
// bun hoists React packages into separate .bun/ paths across nested
// workspaces, which can leave tests with mismatched React/React DOM copies.
// Intercept Node's CJS resolution so every require resolves to the repo-root
// installation.
// Wrapped in try/catch so CI environments without react don't crash.
try {
  const rootRequire = Module.createRequire(import.meta.url);
  const rootReactDir = path.dirname(rootRequire.resolve("react/package.json"));
  const rootReactDomDir = path.dirname(
    rootRequire.resolve("react-dom/package.json"),
  );

  const moduleInternals = Module as typeof Module & {
    _resolveFilename: ResolveFilename & {
      [REACT_RESOLVE_PATCH_MARK]?: boolean;
    };
  };
  if (!moduleInternals._resolveFilename[REACT_RESOLVE_PATCH_MARK]) {
    const origResolve = moduleInternals._resolveFilename;
    const patchedResolve = function patchedResolve(
      this: unknown,
      request: string,
      parent: unknown,
      isMain: boolean,
      options: unknown,
    ) {
      const resolved: string = origResolve.call(
        this,
        request,
        parent,
        isMain,
        options,
      );
      if (!resolved.includes("node_modules/.bun/")) {
        return resolved;
      }

      const packageRedirects = [
        {
          needle: "/node_modules/react/",
          targetDir: rootReactDir,
        },
        {
          needle: "/node_modules/react-dom/",
          targetDir: rootReactDomDir,
        },
      ];

      for (const { needle, targetDir } of packageRedirects) {
        const packageIndex = resolved.lastIndexOf(needle);
        if (packageIndex !== -1) {
          const relPath = resolved.slice(packageIndex + needle.length);
          return path.join(targetDir, relPath);
        }
      }

      return resolved;
    } as typeof moduleInternals._resolveFilename;
    patchedResolve[REACT_RESOLVE_PATCH_MARK] = true;
    moduleInternals._resolveFilename = patchedResolve;
  }
} catch {
  // React not available — skip deduplication patch (e.g. CI without react)
}

process.env.VITEST = "true";
// Keep test output focused on failures; individual tests can override.
process.env.LOG_LEVEL ??= "error";
// Allow tests to run without a real database (uses InMemoryDatabaseAdapter).
process.env.ALLOW_NO_DATABASE ??= "true";
// ---------------------------------------------------------------------------
// Bun global shim — Electrobun desktop shell tests run in the Bun runtime,
// but the Vitest pool is Node. Install a minimal shim so that module-level
// code referencing the Bun global (e.g. Bun.spawn, Bun.version) does not
// throw ReferenceError at import time. Individual tests override Bun.spawn
// with vi.fn() in their own setup blocks.
// ---------------------------------------------------------------------------
if (typeof globalThis.Bun === "undefined") {
  (globalThis as Record<string, unknown>).Bun = {
    version: "1.3.11",
    spawn: (_cmd: unknown, _opts?: unknown) => ({
      pid: 0,
      exitCode: 0,
      exited: Promise.resolve(0),
      stdout: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      stderr: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      kill: () => {},
    }),
    spawnSync: (_cmd: unknown, _opts?: unknown) => ({
      exitCode: 0,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
    }),
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    env: { ...process.env },
  };
}

declare global {
  // React 18 testing flag to suppress act() environment warnings.
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

suppressReactTestConsoleErrors();

function ensureStorage(
  target: Record<string, unknown>,
  key: "localStorage" | "sessionStorage",
  fallback?: Storage,
): Storage {
  const existing = target[key];
  if (hasStorageApi(existing)) {
    return existing;
  }
  const storage = fallback ?? createMemoryStorage();
  Object.defineProperty(target, key, {
    value: storage,
    writable: true,
    configurable: true,
  });
  return storage;
}

const sharedLocalStorage = ensureStorage(
  globalThis as Record<string, unknown>,
  "localStorage",
);
const sharedSessionStorage = ensureStorage(
  globalThis as Record<string, unknown>,
  "sessionStorage",
);

if (typeof globalThis.window !== "undefined") {
  const win = globalThis.window as Window & Record<string, unknown>;
  ensureStorage(win, "localStorage", sharedLocalStorage);
  ensureStorage(win, "sessionStorage", sharedSessionStorage);
  // jsdom ships noisy "Not implemented" confirm/alert stubs. Replace them
  // eagerly so tests can override them without polluting stderr. Default to
  // "cancel" to preserve the old falsey fallback behavior in app flows.
  win.confirm = vi.fn().mockReturnValue(false);
  win.alert = vi.fn();

  // Programmatic download/external-link clicks should exercise handlers in
  // tests without asking jsdom to perform a full navigation.
  const anchorPrototype = globalThis.HTMLAnchorElement?.prototype as
    | ({
        click?: () => void;
        [ANCHOR_CLICK_PATCH_MARK]?: boolean;
      } & Record<string, unknown>)
    | undefined;
  const originalAnchorClick = anchorPrototype?.click;
  if (
    anchorPrototype &&
    typeof originalAnchorClick === "function" &&
    !anchorPrototype[ANCHOR_CLICK_PATCH_MARK]
  ) {
    Object.defineProperty(anchorPrototype, "click", {
      configurable: true,
      writable: true,
      value: function patchedAnchorClick(this: HTMLAnchorElement) {
        const href = this.getAttribute("href") ?? "";
        const target = this.getAttribute("target") ?? "";
        const shouldSuppressNavigation =
          this.hasAttribute("download") ||
          target === "_blank" ||
          /^(?:https?:|blob:|data:)/i.test(href);

        if (shouldSuppressNavigation) {
          this.dispatchEvent(
            new window.MouseEvent("click", {
              bubbles: true,
              cancelable: true,
              composed: true,
            }),
          );
          return;
        }

        return originalAnchorClick.call(this);
      },
    });
    anchorPrototype[ANCHOR_CLICK_PATCH_MARK] = true;
  }

  const virtualConsole = (
    globalThis.window as typeof globalThis.window & {
      _virtualConsole?: {
        emit?: ((eventName: string, ...args: unknown[]) => unknown) & {
          [JSDOM_EMIT_PATCH_MARK]?: boolean;
        };
      };
    }
  )._virtualConsole;
  const originalEmit = virtualConsole?.emit;
  if (
    virtualConsole &&
    typeof originalEmit === "function" &&
    !originalEmit[JSDOM_EMIT_PATCH_MARK]
  ) {
    const patchedEmit = function patchedEmit(eventName, ...args) {
      const [firstArg] = args;
      if (
        eventName === "jsdomError" &&
        firstArg instanceof Error &&
        firstArg.message === "Not implemented: navigation to another Document"
      ) {
        return;
      }
      return originalEmit.call(this, eventName, ...args);
    } as typeof originalEmit;
    patchedEmit[JSDOM_EMIT_PATCH_MARK] = true;
    virtualConsole.emit = patchedEmit;
  }
}

import { withIsolatedTestHome } from "./test-env";

// ── Environment isolation ────────────────────────────────────────────
// Snapshot process.env at file level so that env mutations made by any test
// or beforeAll/afterAll hooks don't leak to the next test file when running
// in the same forked worker.
const fileEnvSnapshot = { ...process.env };

afterAll(() => {
  // Restore env to its state when this file started.
  for (const key of Object.keys(process.env)) {
    if (!(key in fileEnvSnapshot)) {
      delete process.env[key];
    } else if (process.env[key] !== fileEnvSnapshot[key]) {
      process.env[key] = fileEnvSnapshot[key];
    }
  }
  for (const key of Object.keys(fileEnvSnapshot)) {
    if (!(key in process.env)) {
      process.env[key] = fileEnvSnapshot[key];
    }
  }
});

const testEnv = withIsolatedTestHome();
afterAll(() => testEnv.cleanup());

afterAll(() => {
  // Some integration-style tests can leave chokidar/fs watchers open in workers,
  // which keeps Vitest from exiting cleanly on local runs.
  const getActiveHandles = (
    process as {
      _getActiveHandles?: () => unknown[];
    }
  )._getActiveHandles;
  const handles = getActiveHandles?.() ?? [];
  for (const handle of handles) {
    if (!handle || typeof handle !== "object") continue;
    const name = (handle as { constructor?: { name?: string } }).constructor
      ?.name;
    if (name !== "FSWatcher" && name !== "FSEvent" && name !== "StatWatcher") {
      continue;
    }
    try {
      (handle as { close?: () => void }).close?.();
    } catch {
      // Best-effort cleanup only.
    }
  }
});

afterEach(() => {
  // Guard against leaked fake timers across test files/workers.
  vi.useRealTimers();
  // Reset module mocks to prevent vi.mock() pollution across test files.
  vi.restoreAllMocks();
});

type MockHostNode = {
  children: unknown[];
  style: Record<string, unknown>;
  appendChild: (child: unknown) => void;
  removeChild: (child: unknown) => void;
  insertBefore: (child: unknown, before: unknown) => void;
  removeAttribute: () => void;
  setAttribute: () => void;
  addEventListener: () => void;
  removeEventListener: () => void;
  focus: () => void;
  getBoundingClientRect: () => DOMRect;
  querySelector: () => null;
  querySelectorAll: () => unknown[];
};

type TestRendererModule = typeof testRenderer & {
  create?: (children: unknown, options?: Record<string, unknown>) => unknown;
};

// Provide a safe default node mock for react-test-renderer portals and host nodes.
const defaultCreateNodeMock = (
  element: { type?: unknown } | null | undefined,
) => {
  if (typeof element?.type !== "string") {
    return null;
  }

  const node: MockHostNode = {
    children: [],
    style: {},
    appendChild: (child: unknown) => {
      node.children.push(child);
    },
    removeChild: (child: unknown) => {
      const index = node.children.indexOf(child);
      if (index >= 0) {
        node.children.splice(index, 1);
      }
    },
    insertBefore: (child: unknown, before: unknown) => {
      const index = node.children.indexOf(before);
      if (index === -1) {
        node.children.push(child);
      } else {
        node.children.splice(index, 0, child);
      }
    },
    removeAttribute: () => {},
    setAttribute: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    focus: () => {},
    getBoundingClientRect: () => ({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    }),
    querySelector: () => null,
    querySelectorAll: () => [],
  };

  return node;
};

const testRendererModule = testRenderer as TestRendererModule;
const originalCreate = testRendererModule.create;
const createDescriptor =
  typeof testRenderer === "object" && testRenderer !== null
    ? Object.getOwnPropertyDescriptor(testRenderer, "create")
    : undefined;
if (
  typeof originalCreate === "function" &&
  (createDescriptor?.writable === true || createDescriptor?.set)
) {
  Reflect.set(
    testRenderer as object,
    "create",
    (children: unknown, options: Record<string, unknown> = {}) => {
      if (!options.createNodeMock) {
        options = {
          ...options,
          createNodeMock: defaultCreateNodeMock,
        };
      }

      return originalCreate.call(testRenderer, children, options);
    },
  );
}
