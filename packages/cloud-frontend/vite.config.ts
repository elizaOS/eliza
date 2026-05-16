import { existsSync, statSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import mdx from "@mdx-js/rollup";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMdxFrontmatter from "remark-mdx-frontmatter";
import { defineConfig, loadEnv } from "vite";

// Resolve aliases. Aliases that previously pointed at `cloud/packages/{lib,db,
// types,content}` now resolve to the consolidated `@elizaos/cloud-shared`
// package at `packages/cloud-shared/src/{lib,db,types}` and to the local
// `content/` directory in this package.
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

function resolveFile(path: string): string {
  const candidates = [
    path,
    `${path}.ts`,
    `${path}.tsx`,
    `${path}/index.ts`,
    `${path}/index.tsx`,
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return path;
}

// Some subtrees under `@/lib/*`, `@/db/*`, `@/types/*`, `@/components/*` were
// moved into this package (browser-only files: utils.ts, hooks, providers,
// stores, toast-adapter). Build a vite plugin that intercepts those imports
// and prefers the local `src/<subpath>` when the file exists, falling back to
// cloud-shared otherwise. This avoids touching hundreds of imports in source
// files.
function resolveLocalFirst(
  id: string,
  localBase: string,
  sharedBase: string,
): string {
  const sub = id.replace(/^@\/(?:lib|db|types|components)\/?/, "");
  for (const base of [localBase, sharedBase]) {
    const resolved = resolveFile(r(`${base}/${sub}`));
    if (resolved !== r(`${base}/${sub}`)) {
      return resolved;
    }
  }
  return r(`${sharedBase}/${sub}`);
}

// Whitelist of env vars that get baked into the client bundle. Anything not
// listed here is *not* exposed — keeps server-only secrets out of the SPA.
// Mirrors the `NEXT_PUBLIC_*` vars that consumer code actually reads via
// `process.env.*` (historical Next.js-shaped call sites).
const PUBLIC_ENV_KEYS = [
  "NEXT_PUBLIC_API_URL",
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_ELIZA_APP_URL",
  "NEXT_PUBLIC_STEWARD_API_URL",
  "NEXT_PUBLIC_STEWARD_TENANT_ID",
  "NEXT_PUBLIC_STEWARD_AUTH_ENABLED",
  "NEXT_PUBLIC_NETWORK",
  "NEXT_PUBLIC_DEVNET",
  "NEXT_PUBLIC_SOLANA_RPC_URL",
  "NEXT_PUBLIC_ALCHEMY_API_KEY",
  "NEXT_PUBLIC_HELIUS_API_KEY",
  "NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID",
  "NEXT_PUBLIC_ELIZA_API_URL",
  "NEXT_PUBLIC_ELIZA_API_KEY",
  "NEXT_PUBLIC_ELIZA_APP_ID",
  "NEXT_PUBLIC_ELIZA_PROXY_URL",
  "NEXT_PUBLIC_IS_MOBILE_APP",
  "NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH",
  "NEXT_PUBLIC_ASSETS_CDN_URL",
] as const;

// `.env.local` lives at `cloud/` (the monorepo's web root), one level above
// this Vite app at `cloud/apps/frontend/`. Resolve the env directory absolute
// so `loadEnv` finds it regardless of where `bun run build` was invoked from.
const ENV_DIR = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig(({ mode }) => {
  // `loadEnv` reads `.env`, `.env.local`, `.env.<mode>`, `.env.<mode>.local`
  // from ENV_DIR. Process env (e.g. CI/Pages build env) overrides.
  const fileEnv = loadEnv(mode, ENV_DIR, ["NEXT_PUBLIC_", "VITE_"]);
  const merged: Record<string, string | undefined> = {
    ...fileEnv,
    ...process.env,
  };

  const defineMap: Record<string, string> = {};
  for (const key of PUBLIC_ENV_KEYS) {
    const value = merged[key];
    if (value != null && value !== "") {
      defineMap[`process.env.${key}`] = JSON.stringify(value);
    }
  }
  // Catch-all for unmatched `process.env.X` access resolves to `undefined`
  // via `({}).X` rather than throwing a ReferenceError at runtime. The
  // specific keys above must be declared *before* this entry so Vite's
  // textual replacement matches them first.
  defineMap["process.env"] = "{}";
  const apiProxyTarget =
    process.env.VITE_API_PROXY_TARGET ||
    process.env.PLAYWRIGHT_API_URL ||
    "http://localhost:8787";
  const devServerPort = Number.parseInt(process.env.PORT || "3000", 10);
  const allowedHosts = (process.env.VITE_ALLOWED_HOSTS || "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);

  return {
    plugins: [
      {
        name: "eliza-blog-raw-mdx",
        enforce: "pre",
        transform(source, id) {
          const queryIndex = id.indexOf("?");
          const filePath = queryIndex === -1 ? id : id.slice(0, queryIndex);
          const query = queryIndex === -1 ? "" : id.slice(queryIndex + 1);
          if (query === "raw" || query.includes("&raw")) {
            return null;
          }
          if (
            !filePath.endsWith(".mdx") ||
            !filePath.includes("/content/blog/")
          ) {
            return null;
          }

          return `export default ${JSON.stringify(source)};`;
        },
      },
      {
        enforce: "pre",
        // No `providerImportSource` — `@mdx-js/react`'s runtime provider can't
        // be resolved from package content/*.mdx (it's hoisted under
        // frontend's node_modules only). MDX imports the local docs components
        // directly, and markdown elements are styled via CSS.
        ...mdx({
          exclude: ["**/content/blog/**"],
          remarkPlugins: [remarkGfm, remarkFrontmatter, remarkMdxFrontmatter],
        }),
      },
      react({ include: /\.(jsx|tsx|mdx)$/ }),
      tailwindcss(),
      // Resolve `@/lib/*`, `@/db/*`, `@/types/*`, `@/components/*` with
      // local-first / cloud-shared-fallback semantics. Some files (utils.ts,
      // toast-adapter, hooks, providers, chat-store) moved from cloud-shared
      // into this package; the rest still live in cloud-shared.
      {
        name: "eliza-cloud-frontend-alias-fallback",
        enforce: "pre",
        resolveId(source) {
          if (source === "@/lib/utils") {
            return r("./src/lib/utils.ts");
          }
          if (source.startsWith("@/lib/hooks/")) {
            return resolveLocalFirst(
              source,
              "./src/hooks",
              "../cloud-shared/src/lib/hooks",
            );
          }
          if (source.startsWith("@/lib/providers/")) {
            return resolveLocalFirst(
              source,
              "./src/providers",
              "../cloud-shared/src/lib/providers",
            );
          }
          if (source.startsWith("@/lib/stores/")) {
            return resolveLocalFirst(
              source,
              "./src/lib/stores",
              "../cloud-shared/src/lib/stores",
            );
          }
          if (source.startsWith("@/lib/")) {
            return resolveLocalFirst(
              source,
              "./src/lib",
              "../cloud-shared/src/lib",
            );
          }
          if (source.startsWith("@/db/")) {
            return resolveLocalFirst(
              source,
              "./src/db",
              "../cloud-shared/src/db",
            );
          }
          if (source.startsWith("@/types/")) {
            return resolveLocalFirst(
              source,
              "./src/types",
              "../cloud-shared/src/types",
            );
          }
          if (source.startsWith("@/components/")) {
            return resolveLocalFirst(
              source,
              "./src/components",
              "../../packages/ui/src/cloud-ui/components",
            );
          }
          if (source.startsWith("@/")) {
            return resolveFile(r(`./src/${source.slice(2)}`));
          }
          return null;
        },
      },
    ],
    optimizeDeps: {
      // Avoid scanning the giant transitive graph from packages/lib at
      // dev-server boot.
      entries: ["src/main.tsx"],
      // Force-include the crypto graph so vite/rolldown's optimizer wires
      // every CommonJS `require_*` wrapper before any consumer call site.
      // Without this, the prebundle for elliptic/hash-base/create-hash
      // ends up referencing `require_inherits` before its wrapper is
      // defined (a known rolldown CJS hoisting issue), which crashes the
      // React tree on /login. Pre-bundling them as a unit forces the
      // wrappers into deterministic top-level position in the chunk.
      include: [
        "elliptic",
        "inherits",
        "hash-base",
        "create-hash",
        "create-hmac",
        "browserify-sign",
        "secp256k1",
      ],
    },
    resolve: {
      dedupe: ["react", "react-dom", "lucide-react"],
      alias: [
        // The upstream `inherits` package's main entry tries
        // `require('util').inherits` first and falls back to
        // `inherits_browser.js` inside a try/catch. Vite aliases `util`
        // to an empty shim, so the real path is the fallback — but
        // rolldown's CommonJS optimizeDeps prebundle ends up referencing
        // `require_inherits_browser` before its wrapper is hoisted, which
        // throws inside elliptic / hash-base / create-hash and crashes
        // the React tree on /login. Resolve `inherits` directly to a
        // browser-safe shim so the try/catch never runs at all. Pairs
        // with the `optimizeDeps.include` block above which forces the
        // crypto graph to bundle as a single deterministic chunk.
        { find: /^inherits$/, replacement: r("./src/shims/inherits.cjs") },
        // Real Buffer polyfill — Solana wallet adapters, viem, ethers, base64
        // helpers all depend on Buffer. Stubbing it throws at runtime when a
        // browser-reachable code path constructs a Buffer.
        { find: /^(node:)?buffer$/, replacement: "buffer" },
        // Real process shim — many libs read `process.env.NODE_ENV`,
        // `process.browser`, or call `process.nextTick(...)`. The empty stub
        // throws on access, breaking module init for those libs.
        { find: /^(node:)?process$/, replacement: r("./src/shims/process.ts") },
        // Stub Node built-ins that legacy server-side modules import. The SPA
        // never executes those code paths at runtime (any function that needs
        // them is gated behind `typeof window === "undefined"` or only called
        // server-side), but Rollup still has to resolve the module graph at
        // build time.
        {
          find: /^node:(fs|fs\/promises|path|os|crypto|stream|http|https|zlib|net|tls|child_process|util|url|events|querystring|assert|vm|worker_threads|cluster|dgram|dns|punycode|readline|repl|string_decoder|tty|module|inspector|perf_hooks|async_hooks|trace_events|v8)$/,
          replacement: r("./src/shims/empty.ts"),
        },
        {
          find: /^(fs|fs\/promises|path|os|crypto|stream|http|https|zlib|net|tls|child_process|vm|url|util|events|querystring|assert|punycode|readline|repl|string_decoder|tty|worker_threads|perf_hooks|module|inspector|async_hooks|trace_events|v8)$/,
          replacement: r("./src/shims/empty.ts"),
        },

        // Order matters: longer prefixes / subpath aliases must precede broader
        // ones. Use regex/exact `find` values so `@elizaos/ui/foo` doesn't
        // get rewritten to `…/index.ts/foo`.
        //
        // The named subpath aliases below mirror the `exports` map in
        // `packages/ui/package.json` — keep them in sync. They must
        // precede the catch-all `@elizaos/ui/<...>` rule because vite
        // resolves aliases in declaration order.
        {
          find: /^@elizaos\/ui$/,
          replacement: r("../ui/src/cloud-ui/index.ts"),
        },
        {
          find: /^@elizaos\/ui\/primitives$/,
          replacement: r("../ui/src/cloud-ui/components/primitives.ts"),
        },
        {
          find: /^@elizaos\/ui\/brand$/,
          replacement: r("../ui/src/cloud-ui/components/brand/index.ts"),
        },
        {
          find: /^@elizaos\/ui\/layout$/,
          replacement: r("../ui/src/cloud-ui/components/layout/index.ts"),
        },
        {
          find: /^@\/docs\/components$/,
          replacement: r(
            "../ui/src/cloud-ui/components/docs/mdx-components.tsx",
          ),
        },
        { find: /^@elizaos\/ui\/(.*)$/, replacement: `${r("../ui/src")}/$1` },
        // Cloud-shared (consolidation of former @elizaos/billing, cloud-db,
        // cloud-lib, cloud-types, cloud-routing packages). Subpath exports
        // mirror packages/cloud-shared/package.json.
        {
          find: /^@elizaos\/cloud-shared$/,
          replacement: r("../cloud-shared/src/index.ts"),
        },
        {
          find: /^@elizaos\/cloud-shared\/(.*)$/,
          replacement: `${r("../cloud-shared/src")}/$1`,
        },
        {
          find: /^@\/lib\/hooks\/(.*)$/,
          replacement: `${r("./src/hooks")}/$1`,
        },
        {
          find: /^@\/lib\/providers\/(.*)$/,
          replacement: `${r("./src/providers")}/$1`,
        },
        {
          find: /^@\/lib\/stores\/(.*)$/,
          replacement: `${r("./src/lib/stores")}/$1`,
        },
        {
          find: /^@\/lib\/utils\/logger$/,
          replacement: r("../cloud-shared/src/lib/utils/logger.ts"),
        },
        {
          find: /^@\/lib\/config\/feature-flags$/,
          replacement: r("../cloud-shared/src/lib/config/feature-flags.ts"),
        },
        {
          find: /^@\/lib\/onboarding\/tours$/,
          replacement: r("../cloud-shared/src/lib/onboarding/tours.ts"),
        },
        {
          find: /^@\/lib\/utils\/copy-to-clipboard$/,
          replacement: r("../cloud-shared/src/lib/utils/copy-to-clipboard.ts"),
        },
        {
          find: /^@\/lib\/utils\/default-avatar$/,
          replacement: r("../cloud-shared/src/lib/utils/default-avatar.ts"),
        },
        {
          find: /^@\/lib\/utils\/referral-invite-url$/,
          replacement: r(
            "../cloud-shared/src/lib/utils/referral-invite-url.ts",
          ),
        },
        {
          find: /^@\/lib\/utils\/referral-me-fetch$/,
          replacement: r("../cloud-shared/src/lib/utils/referral-me-fetch.ts"),
        },
        // `@/lib/*`, `@/db/*`, `@/types/*`, `@/components/*` are handled by
        // the `eliza-cloud-frontend-alias-fallback` plugin above (local-first,
        // cloud-shared fallback).
        {
          find: /^@\/packages(\/.*)?$/,
          replacement: `${r("../cloud-shared/src")}$1`,
        },
      ],
    },
    server: {
      port: Number.isFinite(devServerPort) ? devServerPort : 3000,
      ...(allowedHosts.length ? { allowedHosts } : {}),
      proxy: {
        "/api": {
          target: apiProxyTarget,
          changeOrigin: true,
          xfwd: true,
        },
        "/steward": {
          target: apiProxyTarget,
          changeOrigin: true,
          xfwd: true,
        },
      },
    },
    build: {
      outDir: "dist",
      sourcemap: true,
      target: "esnext",
    },
    // The SSR build (`vite build --ssr src/entry-server.tsx`) needs to bundle
    // the workspace `@elizaos/ui` + `@/lib/*` graph rather than treat
    // them as externals — they aren't published to npm and resolve via the
    // aliases above. Bundling them keeps the prerender script's `import()` of
    // `dist-ssr/entry-server.js` self-contained.
    ssr: {
      noExternal: [
        /^@elizaos\/ui/,
        /^@\/lib/,
        /^@\/db/,
        /^@\/types/,
        /^@\/components/,
        /^@\/packages/,
        /^@\//,
        "react-router-dom",
        "react-router",
        "react-helmet-async",
        "framer-motion",
        "lucide-react",
        "buffer",
      ],
    },
    css: {
      // The @tailwindcss/vite plugin handles Tailwind directly; disable
      // PostCSS auto-discovery so the legacy cloud/postcss.config.mjs is
      // ignored.
      postcss: { plugins: [] },
    },
    define: defineMap,
  };
});
