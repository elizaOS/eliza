/**
 * Vitest config for the UI unit/component suite (jsdom, TZ=UTC, aliases).
 */
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageRoot = fileURLToPath(new URL("./", import.meta.url));
const monorepoRoot = resolve(packageRoot, "../..");
const uiSrc = resolve(packageRoot, "src");
const sharedSrc = resolve(monorepoRoot, "packages/shared/src");
const coreSrc = resolve(monorepoRoot, "packages/core/src");
const importConversationsSrc = resolve(
  monorepoRoot,
  "packages/import-conversations/src",
);
const cloudSharedSrc = resolve(monorepoRoot, "packages/cloud/shared/src");
const loggerSrc = resolve(monorepoRoot, "packages/logger/src");
const tuiSrc = resolve(monorepoRoot, "packages/tui/src");
const bunRuntimeSrc = resolve(
  monorepoRoot,
  "plugins/plugin-native-bun-runtime/src/index.ts",
);
const hostExternalStub = resolve(packageRoot, "test/stubs/host-external.ts");

// Resolve react/react-dom using the same version that lucide-react (or any
// other UI dep) natively resolves.  In a bun workspace the peer-hash variant
// of each dep carries its own react symlink — we discover that path so the
// Vite alias always points to the *same* physical copy that CJS-requiring
// packages see at runtime, eliminating "Invalid hook call" errors.
//
// Strategy:
//  1. Resolve lucide-react from packages/ui (its bun-cache variant carries
//     the authoritative peer-react symlink).
//  2. From lucide-react's location, resolve "react" — that is the canonical
//     react instance for this workspace/environment.
//  3. Fall back to the standard createRequire resolution if lucide-react is
//     absent (e.g., stripped build environments).
const _require = createRequire(import.meta.url);
let reactPath: string;
let reactDomPath: string;
try {
  const lucidePath = _require.resolve("lucide-react");
  const lucideReq = createRequire(lucidePath);
  reactPath = dirname(lucideReq.resolve("react/package.json"));
  reactDomPath = dirname(lucideReq.resolve("react-dom/package.json"));
} catch {
  reactPath = dirname(_require.resolve("react/package.json"));
  reactDomPath = dirname(_require.resolve("react-dom/package.json"));
}

export default defineConfig({
  plugins: [
    {
      name: "ui-test-react-dedupe",
      enforce: "pre" as const,
      resolveId(id: string) {
        if (id === "react" || id === "react/index.js")
          return resolve(reactPath, "index.js");
        if (id === "react/jsx-runtime" || id === "react/jsx-runtime.js")
          return resolve(reactPath, "jsx-runtime.js");
        if (id === "react/jsx-dev-runtime" || id === "react/jsx-dev-runtime.js")
          return resolve(reactPath, "jsx-dev-runtime.js");
        if (id === "react-dom" || id === "react-dom/index.js")
          return resolve(reactDomPath, "index.js");
        if (id === "react-dom/client" || id === "react-dom/client.js")
          return resolve(reactDomPath, "client.js");
        return null;
      },
    },
  ],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      {
        find: /^@elizaos\/ui$/,
        replacement: resolve(uiSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/ui\/(.+)$/,
        replacement: resolve(uiSrc, "$1"),
      },
      {
        find: /^@elizaos\/shared$/,
        replacement: resolve(sharedSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/shared\/(.+)$/,
        replacement: resolve(sharedSrc, "$1"),
      },
      {
        find: /^@elizaos\/cloud-shared$/,
        replacement: resolve(cloudSharedSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/cloud-shared\/(.+)$/,
        replacement: resolve(cloudSharedSrc, "$1"),
      },
      {
        find: /^@elizaos\/logger$/,
        replacement: resolve(loggerSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/tui$/,
        replacement: resolve(tuiSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/tui\/(.+)$/,
        replacement: resolve(tuiSrc, "$1"),
      },
      {
        find: /^@elizaos\/core$/,
        replacement: resolve(coreSrc, "index.node.ts"),
      },
      {
        find: /^@elizaos\/core\/(.+)$/,
        replacement: resolve(coreSrc, "$1"),
      },
      {
        find: /^@elizaos\/import-conversations\/browser$/,
        replacement: resolve(importConversationsSrc, "browser.ts"),
      },
      {
        find: /^@elizaos\/import-conversations$/,
        replacement: resolve(importConversationsSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/app-core(?:\/browser|\/ui-compat)?$/,
        replacement: hostExternalStub,
      },
      {
        find: /^@elizaos\/capacitor-(contacts|messages|mobile-signals|phone|system)$/,
        replacement: hostExternalStub,
      },
      {
        find: /^@elizaos\/plugin-browser$/,
        replacement: hostExternalStub,
      },
      {
        // Dynamically loaded by DynamicViewLoader as a host-external plugin;
        // alias it so the ui test build doesn't require its built dist.
        find: /^@elizaos\/plugin-training$/,
        replacement: hostExternalStub,
      },
      {
        // Browser-safe screen-time helper imported by DynamicViewLoader; resolve
        // to source so the ui test build doesn't require plugin-health's dist.
        find: /^@elizaos\/plugin-health\/screen-time\/mobile-signal-setup$/,
        replacement: resolve(
          monorepoRoot,
          "plugins/plugin-health/src/screen-time/mobile-signal-setup.ts",
        ),
      },
      {
        find: /^@elizaos\/capacitor-bun-runtime$/,
        replacement: bunRuntimeSrc,
      },
      {
        find: /^react$/,
        replacement: resolve(reactPath, "index.js"),
      },
      {
        find: /^react\/jsx-runtime$/,
        replacement: resolve(reactPath, "jsx-runtime.js"),
      },
      {
        find: /^react\/jsx-dev-runtime$/,
        replacement: resolve(reactPath, "jsx-dev-runtime.js"),
      },
      {
        find: /^react-dom$/,
        replacement: resolve(reactDomPath, "index.js"),
      },
      {
        find: /^react-dom\/client$/,
        replacement: resolve(reactDomPath, "client.js"),
      },
      {
        find: /^zlib-sync$/,
        replacement: resolve(packageRoot, "test/stubs/zlib-sync.ts"),
      },
      {
        find: /^discord\.js$/,
        replacement: resolve(packageRoot, "test/stubs/discord-js.ts"),
      },
      // `@capacitor/app` is an optional native bridge the host app supplies — not
      // a declared dep of `@elizaos/ui`. Tests `vi.mock` it; alias to a resolvable
      // test double so vite's transform doesn't fail in CI where it isn't installed.
      {
        find: /^@capacitor\/app$/,
        replacement: resolve(packageRoot, "test/stubs/capacitor-app.ts"),
      },
      // `@elizaos/capacitor-llama` and `@elizaos/plugin-wallet-ui` are workspace packages
      // built to dist/ only; UI tests `vi.mock` them, so alias to stubs so the
      // import resolves in CI where their dist/ isn't built.
      {
        find: /^@elizaos\/capacitor-llama$/,
        replacement: resolve(
          packageRoot,
          "test/stubs/elizaos-capacitor-llama.ts",
        ),
      },
      {
        find: /^@elizaos\/capacitor-agent$/,
        replacement: resolve(
          packageRoot,
          "test/stubs/elizaos-capacitor-agent.ts",
        ),
      },
      {
        find: /^@elizaos\/app-wallet$/,
        replacement: resolve(packageRoot, "test/stubs/elizaos-app-wallet.ts"),
      },
      {
        find: /^@elizaos\/plugin-wallet-ui$/,
        replacement: resolve(
          monorepoRoot,
          "plugins/plugin-wallet-ui/src/index.ts",
        ),
      },
      {
        find: /^@elizaos\/cloud-sdk\/cloud-setup-session$/,
        replacement: resolve(
          monorepoRoot,
          "packages/cloud/sdk/src/cloud-setup-session/index.ts",
        ),
      },
      {
        find: /^@elizaos\/cloud-sdk\/cloud-setup-session\/(.+)$/,
        replacement: resolve(
          monorepoRoot,
          "packages/cloud/sdk/src/cloud-setup-session/$1",
        ),
      },
    ],
  },
  test: {
    setupFiles: ["./vitest.setup.ts"],
    pool: "forks",
    poolOptions: {
      forks: {
        // The heaviest jsdom suites (App.screen-background-fuzz walks the FULL
        // builtin-tab universe under a mounted <App /> several times) peak past
        // Node's ~4 GB default old-space and OOM-kill the fork worker, which
        // vitest then reports as "Worker exited unexpectedly" with the file's
        // results lost. Raise only the ceiling — small suites stay small.
        execArgv: ["--max-old-space-size=8192"],
      },
    },
    server: {
      deps: {
        // Inline packages that use React through Vite's transform pipeline so
        // the react/react-dom resolve.alias rules apply and all callers end up
        // with exactly one React module instance.  We list the known consumers
        // rather than using `inline: true` because fully-inline mode breaks
        // jsdom's internal CJS `require("@exodus/bytes")` chain.
        inline: [
          /react/,
          /react-dom/,
          /@testing-library/,
          /lucide-react/,
          /motion/,
          /@radix-ui/,
          /vaul/,
          /sonner/,
          /embla/,
          /recharts/,
          /@xyflow/,
          /streamdown/,
          /tokenlens/,
          // @exodus\/bytes ships pure-ESM exports; CJS-requiring code (e.g.,
          // html-encoding-sniffer inside jsdom) cannot `require()` it without
          // Vite's transform wrapping it as a virtual CJS module.
          /@exodus\/bytes/,
          /html-encoding-sniffer/,
        ],
      },
    },
    environment: "node",
    environmentOptions: {
      // jsdom 29 throws `SecurityError: localStorage is not available for
      // opaque origins` unless a concrete url is configured. Tests that
      // declare `// @vitest-environment jsdom` need this to access
      // window.localStorage / window.sessionStorage.
      jsdom: { url: "http://localhost/" },
    },
    include: [
      "__tests__/**/*.test.ts",
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      // Pure-logic unit tests for the story-gate audit scripts (e.g. the
      // console/a11y baseline-allowlist ratchet) run in the standard suite.
      "test/**/*.test.mjs",
    ],
    exclude: [
      "dist/**",
      "**/node_modules/**",
      "**/*.live.test.{ts,tsx}",
      "**/*.real.test.{ts,tsx}",
      "**/*.integration.test.{ts,tsx}",
      "**/*.e2e.test.{ts,tsx}",
      "**/*.e2e.spec.{ts,tsx}",
      "**/*.spec.{ts,tsx}",
      // Heavy jsdom flows live under __e2e__/ — they routinely take >5min
      // and blow past the global suite budget. Run them via the dedicated
      // `test:slow` script (vitest.e2e.config.ts) with a 15min cap.
      "**/__e2e__/**",
    ],
  },
});
