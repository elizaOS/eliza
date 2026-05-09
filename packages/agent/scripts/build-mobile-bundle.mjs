#!/usr/bin/env bun

// build-mobile-bundle.mjs — produce the on-device agent payload.
//
// Output layout (consumed by the Phase A asset pipeline):
//
//   eliza/packages/agent/dist-mobile/
//     agent-bundle.js              the actual bun-runnable payload
//     pglite.wasm                  PGlite WebAssembly module
//     initdb.wasm                  PGlite init database WebAssembly module
//     pglite.data                  PGlite filesystem image
//     vector.tar.gz                pgvector contrib (referenced via ../)
//     fuzzystrmatch.tar.gz         fuzzystrmatch contrib (referenced via ../)
//     plugins-manifest.json        list of plugins statically baked into the bundle
//
// What this build does NOT do:
//   - Stage `node_modules`. All `MOBILE_CORE_PLUGINS` resolve through
//     `STATIC_ELIZA_PLUGINS` in the agent runtime (via static `import * as
//     pluginX from "@elizaos/plugin-X"`), so they are inlined by `Bun.build`.
//   - Bundle a model. Inference goes through `ANTHROPIC_API_KEY` /
//     `ELIZAOS_CLOUD_API_KEY` from the user's onboarding for first-light.
//
// PGlite extension paths:
//   `@electric-sql/pglite` resolves four assets via `new URL(..., import.meta.url)`:
//     - "./pglite.wasm"            => same dir as the bundle
//     - "./initdb.wasm"            => same dir as the bundle
//     - "./pglite.data"            => same dir as the bundle
//     - "../vector.tar.gz"         => one dir above the bundle
//     - "../fuzzystrmatch.tar.gz"  => one dir above the bundle
//   After `Bun.build`, `import.meta.url` becomes the bundle's path, so we
//   ship the four files alongside it and the asset pipeline mounts them so
//   the relative paths land. Phase A is responsible for placing the .tar.gz
//   files at parent-of-bundle on the device.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentRoot = path.resolve(here, "..");
// agentRoot = repoRoot/packages/agent → two parents up is the repo root.
// (Earlier versions assumed eliza's outer-repo layout where agent
// lived at eliza/packages/agent/, requiring three `..`s. That hop is
// the source of every "could not locate @electric-sql/pglite/dist" or
// "agent-bundle.js not found" error in CI.)
const repoRoot = path.resolve(agentRoot, "..", "..");
const outDir = path.join(agentRoot, "dist-mobile");
const stubsDir = path.join(here, "mobile-stubs");
const entry = path.join(agentRoot, "src", "bin.ts");

console.log("[build-mobile] agent root:", agentRoot);
console.log("[build-mobile] output dir:", outDir);

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

// Ensure generated keyword data exists. `@elizaos/shared` ships a
// runtime-loaded `validation-keyword-data.js` that's produced by
// `packages/shared/scripts/generate-keywords.mjs` rather than checked into
// the repo. Without it, Bun.build fails with "Could not resolve:
// ./generated/validation-keyword-data.js" because the i18n module imports it
// directly. Re-run the generator before bundling so a fresh checkout
// (no prior `bun run build`) still produces a working bundle.
const sharedGeneratedFile = path.resolve(
  repoRoot,
  "packages",
  "shared",
  "src",
  "i18n",
  "generated",
  "validation-keyword-data.js",
);
if (!existsSync(sharedGeneratedFile)) {
  console.log(
    "[build-mobile] generating @elizaos/shared i18n keyword data...",
  );
  const result = spawnSync(
    "bun",
    ["run", "--cwd", path.join(repoRoot, "packages", "shared"), "build:i18n"],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    console.error(
      "[build-mobile] FATAL: failed to generate i18n keyword data",
    );
    process.exit(1);
  }
}

function findPgliteDist() {
  // pglite.wasm + pglite.data MUST match the @electric-sql/pglite version
  // that the bundled agent JS resolves at runtime — they're a triple
  // (engine + filesystem image + JS shim). The agent imports from
  // @elizaos/plugin-sql, which pins ^0.3.3, while the eliza repo's
  // top-level deps may pull in a newer 0.4.x for unrelated reasons.
  // Bun's hoisting can park a 0.4.x copy at the top of `node_modules/.bun`
  // and a `readdirSync` walk will pick that up first. The runtime then
  // throws "Invalid FS bundle size: <new> !== <old>" because the bundled
  // 0.3.x WASM expects the 0.3.x .data while we shipped 0.4.x.
  //
  // Resolve plugin-sql's OWN private node_modules first so the staged
  // assets always match the bundled engine. Fall back to the repoRoot
  // hoisted location and to the .bun cache for the bundled-monorepo
  // case where plugin-sql is hoisted instead of nested.
  const candidates = [
    path.join(
      repoRoot,
      "plugins",
      "plugin-sql",
      "typescript",
      "node_modules",
      "@electric-sql",
      "pglite",
      "dist",
    ),
    path.join(repoRoot, "node_modules", "@electric-sql", "pglite", "dist"),
  ];
  const bunDir = path.join(repoRoot, "node_modules", ".bun");
  if (existsSync(bunDir)) {
    // Sort .bun entries by version so that 0.3.x wins over 0.4.x —
    // matches the plugin-sql ^0.3.3 pin without forcing a manual list.
    const sortedEntries = readdirSyncSafe(bunDir)
      .filter((e) => e.startsWith("@electric-sql+pglite@"))
      .sort();
    for (const entry of sortedEntries) {
      candidates.push(
        path.join(
          bunDir,
          entry,
          "node_modules",
          "@electric-sql",
          "pglite",
          "dist",
        ),
      );
    }
  }
  for (const c of candidates) {
    if (existsSync(path.join(c, "pglite.wasm"))) return c;
  }
  return null;
}

function readdirSyncSafe(p) {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

const pgliteDist = findPgliteDist();
if (!pgliteDist) {
  console.error(
    "[build-mobile] FATAL: could not locate @electric-sql/pglite/dist. " +
      "Run `bun install` first.",
  );
  process.exit(1);
}
console.log("[build-mobile] pglite dist:", pgliteDist);

// Native deps without an Android prebuild — replace at bundle time with
// throw-on-call shims. Bun.build's `--external` would leave bare-name imports
// in the output; `ELIZA_PLATFORM=android` would then fail at runtime when
// the mobile bun process can't resolve the missing package. A plugin onResolve
// that maps the bare specifier to the stub path keeps the resolution pure.
//
// AOSP runtime uses bun:ffi against libllama.so + libeliza-llama-shim.so
// directly. node-llama-cpp stays stubbed unconditionally — un-stubbing pulls
// in unresolvable per-platform prebuild packages (e.g.
// `@node-llama-cpp/win-x64-cuda-ext`) that the agent's transitive imports
// reference but the AOSP target cannot install. The static import of
// `runtime/aosp-llama-adapter.ts` from `bin.ts` registers the runtime loader
// when `ELIZA_LOCAL_LLAMA=1`. The Capacitor APK build also keeps the stub
// because its on-device inference goes through llama-cpp-capacitor in the
// WebView, not node-llama-cpp.
const nativeStubs = {
  "node-llama-cpp": path.join(stubsDir, "node-llama-cpp.cjs"),
  "@node-llama-cpp/linux-x64": path.join(stubsDir, "node-llama-cpp.cjs"),
  "@node-llama-cpp/linux-arm64": path.join(stubsDir, "node-llama-cpp.cjs"),
  "@node-llama-cpp/mac-arm64": path.join(stubsDir, "node-llama-cpp.cjs"),
  "@node-llama-cpp/mac-x64": path.join(stubsDir, "node-llama-cpp.cjs"),
  "@node-llama-cpp/win-x64": path.join(stubsDir, "node-llama-cpp.cjs"),
  "onnxruntime-node": path.join(stubsDir, "onnxruntime-node.cjs"),
  "@huggingface/transformers": path.join(
    stubsDir,
    "huggingface-transformers.cjs",
  ),
  "puppeteer-core": path.join(stubsDir, "puppeteer-core.cjs"),
  "pty-manager": path.join(stubsDir, "pty-manager.cjs"),
  sharp: path.join(stubsDir, "sharp.cjs"),
  canvas: path.join(stubsDir, "canvas.cjs"),
  // React + react-dom stubs: workspace plugins (`@elizaos/app-lifeops`,
  // `@elizaos/app-companion`, etc.) re-export their UI subtree from
  // `src/index.ts` for the host app to consume. The agent only loads each
  // package's runtime plugin object, but Bun.build still has to resolve
  // every import in the dependency closure. Without these stubs Bun follows
  // the `react` tsconfig path alias to `@types/react/index.d.ts` and dies
  // parsing TypeScript-only syntax. Nothing on-device renders JSX.
  react: path.join(stubsDir, "react.cjs"),
  "react-dom": path.join(stubsDir, "react-dom.cjs"),
  "react-dom/client": path.join(stubsDir, "react-dom.cjs"),
  "react/jsx-runtime": path.join(stubsDir, "react-jsx-runtime.cjs"),
  "react/jsx-dev-runtime": path.join(stubsDir, "react-jsx-runtime.cjs"),
};

// Optional @elizaos plugins that the agent runtime statically references but
// transitively pull in old/incompatible `@elizaos/core` versions. Stubbing
// them keeps the bundle from carrying multiple AgentRuntime classes (the
// failure mode is: plugin-sql's adapter exposes methods one runtime expects
// but the OTHER runtime doesn't, then `getAgentsByIds is not a function` at
// boot). The narrow list below is exactly the packages whose dependency
// closure pulls in `@elizaos/core@2.0.0-alpha.3` or `2.0.0-alpha.223`.
//
// Other packages — including `@elizaos/app-task-coordinator`,
// `@elizaos/app-companion`, `@elizaos/app-lifeops`, `@elizaos/app-training`
// — are imported by `api/server.ts` as named functions (e.g.
// `wireCoordinatorBridgesWhenReady`). Stubbing them with a Proxy doesn't
// satisfy Bun's `__toESM` namespace builder (it iterates `ownKeys`), so we
// let them bundle. The mobile plugin filter still strips them out of the
// runtime load set, so they don't try to register at boot.
const optionalPluginStubs = {
  "@elizaos/plugin-cli": path.join(stubsDir, "null-plugin.cjs"),
  // Browser bridge can still be resolved through workspace/plugin fallback
  // paths when core plugins are collected. Mobile doesn't run a headless
  // browser, and the runtime's plugin filter strips browser-bridge from the
  // load set anyway, so a null stub prevents Chromium plumbing from entering
  // the bundle if that optional resolution path is reached.
  "@elizaos/plugin-browser": path.join(stubsDir, "null-plugin.cjs"),
  // Server-side connectors that app-lifeops dynamically imports inside
  // its service mixins. Mobile never reaches the runtime path that
  // calls `import("@elizaos/plugin-whatsapp")` or `plugin-signal`, but
  // Bun's bundler still has to resolve them statically. The plugins
  // are workspace-only deps on app-lifeops and aren't in
  // packages/agent's resolution scope, so stub them out here. Trying to
  // bundle the real packages also drags Baileys / libsignal native
  // bindings into the mobile bundle, which is wrong on every axis.
  "@elizaos/plugin-whatsapp": path.join(stubsDir, "null-plugin.cjs"),
  "@elizaos/plugin-signal": path.join(stubsDir, "null-plugin.cjs"),
};

const stubAliases = { ...nativeStubs, ...optionalPluginStubs };

const stubResolverPlugin = {
  name: "eliza-mobile-stubs",
  setup(build) {
    const aliasNames = Object.keys(stubAliases);
    const filter = new RegExp(
      "^(?:" +
        aliasNames
          .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("|") +
        ")(?:/.*)?$",
    );
    build.onResolve({ filter }, (args) => {
      // Match the longest alias that's a prefix of the importer.
      let best = null;
      for (const name of aliasNames) {
        if (
          (args.path === name || args.path.startsWith(`${name}/`)) &&
          (best === null || name.length > best.length)
        ) {
          best = name;
        }
      }
      if (best === null) return undefined;
      return { path: stubAliases[best], namespace: "file" };
    });
  },
};

// Force a single resolution for `@elizaos/core` and `@elizaos/shared`.
//
// `eliza/packages/agent/tsconfig.json` maps `@elizaos/core` to the source
// at `../core/src/index.node.ts`, but `@elizaos/plugin-sql` (and other
// plugin packages) compile against the prebuilt `dist/index.node.js`. Bun
// then bundles BOTH copies, ending up with two distinct AgentRuntime classes
// — the runtime instance receives an adapter from one copy and tries to
// call methods that only exist on the other (`getAgentsByIds is not a
// function`). Pin every `@elizaos/core` (and `@elizaos/shared`) import to
// the same workspace `src/` entry so the bundle ships exactly one identity.
const corePackages = [
  "@elizaos/core",
  "@elizaos/shared",
  "@elizaos/plugin-sql",
];

// Inside the eliza repo the source trees live directly under the repo
// root: `packages/core/`, `packages/shared/`, and
// `plugins/plugin-sql/`. The earlier `eliza/` prefix here was a leftover
// from eliza's outer-repo layout where this whole tree was nested under
// `eliza/`.
const dedupeTargets = {
  "@elizaos/core": path.resolve(
    repoRoot,
    "packages",
    "core",
    "src",
    "index.node.ts",
  ),
  "@elizaos/shared": path.resolve(
    repoRoot,
    "packages",
    "shared",
    "src",
    "index.ts",
  ),
  // Pin plugin-sql to its src as well. The published `dist/node/index.node.js`
  // was compiled against an older `@elizaos/core` API (pre-`getAgentsByIds`),
  // so the bundled `BaseDrizzleAdapter` is missing methods the current runtime
  // depends on. Building from src against the same `@elizaos/core` source the
  // runtime uses keeps the adapter and the runtime in lockstep.
  "@elizaos/plugin-sql": path.resolve(
    repoRoot,
    "plugins",
    "plugin-sql",
    "typescript",
    "index.node.ts",
  ),
};

for (const [pkg, target] of Object.entries(dedupeTargets)) {
  if (!existsSync(target)) {
    console.error(
      `[build-mobile] FATAL: dedupe target for ${pkg} not found: ${target}`,
    );
    process.exit(1);
  }
}

const dedupePlugin = {
  name: "eliza-mobile-core-dedupe",
  setup(build) {
    const filter = new RegExp(
      "^(?:" +
        corePackages
          .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("|") +
        ")$",
    );
    build.onResolve({ filter }, (args) => {
      const target = dedupeTargets[args.path];
      if (!target) return undefined;
      return { path: target, namespace: "file" };
    });
  },
};

const nativeCapacitorPlugin = {
  name: "eliza-mobile-native-capacitor-workspaces",
  setup(build) {
    build.onResolve({ filter: /^@elizaos\/capacitor-[^/]+$/ }, (args) => {
      const packageName = args.path.replace("@elizaos/capacitor-", "");
      const target = path.resolve(
        repoRoot,
        "packages",
        "native-plugins",
        packageName,
        "src",
        "index.ts",
      );
      if (!existsSync(target)) {
        return undefined;
      }
      return { path: target, namespace: "file" };
    });
  },
};

// Force Bun.build to load Zod from its CJS files instead of the ESM ones.
//
// Zod 4's classic ESM source uses re-export aliases like
// `export { _regex as regex } from "./checks.js"` and then references
// `checks.regex(...)` from `schemas.js`. Bun.build (1.3.13 at time of
// writing) inlines those alias hops too aggressively and emits
// `_regex(...)` instead of `checks_exports.regex(...)` — but never
// declares `_regex` in the bundle scope. The on-device runtime then
// crashes with `ReferenceError: _regex is not defined` the first time
// any plugin's `z.string().regex(...)` schema is evaluated.
//
// The CJS variant (`./index.cjs`, `./v4/classic/schemas.cjs`) uses
// `Object.defineProperty(exports, "regex", { get: () => index.regex })`
// which Bun bundles as a real property access, so the bug doesn't
// trigger. Redirect every `zod` and `zod/...` import to its `.cjs`
// counterpart in the same package directory.
const zodCjsResolverPlugin = {
  name: "eliza-mobile-zod-cjs",
  setup(build) {
    build.onResolve({ filter: /^zod(\/.*)?$/ }, (args) => {
      const subpath = args.path === "zod" ? "" : args.path.slice(4);
      const pkgRoot = path.resolve(repoRoot, "node_modules", "zod");
      if (!existsSync(pkgRoot)) return undefined;
      const tryCandidates = subpath
        ? [
            path.join(pkgRoot, `${subpath}.cjs`),
            path.join(pkgRoot, subpath, "index.cjs"),
          ]
        : [path.join(pkgRoot, "index.cjs")];
      for (const candidate of tryCandidates) {
        if (existsSync(candidate)) {
          return { path: candidate, namespace: "file" };
        }
      }
      return undefined;
    });
  },
};

// `@elizaos/ui/capacitor-shell` and any other workspace UI module that
// pulls in CSS would otherwise be included in the bundle. Bun.build emits
// a `.css` artifact in addition to the `.js`, and our `naming` template
// fixes the output filename for both — leading to "Multiple files share
// the same output path". The agent doesn't paint pixels on-device, so
// stub CSS imports with an empty module.
const stubCssPlugin = {
  name: "eliza-mobile-stub-css",
  setup(build) {
    build.onResolve({ filter: /\.css$/ }, () => ({
      path: path.join(stubsDir, "empty.cjs"),
      namespace: "file",
    }));
  },
};

// Workspace plugins like `@elizaos/app-wallet` ship both a `.tsx` source
// file and a stale `.js` artifact (committed by accident from an earlier
// build) at the same path inside `src/`. Bun's default resolver picks the
// `.js` file when both exist, even though the `.tsx` source is the truth.
// This plugin redirects relative imports inside any plugin/package `src/`
// directory to the `.ts`/`.tsx` source if a `.js` of the same name exists.
const stripStaleJsArtifactsPlugin = {
  name: "eliza-mobile-strip-stale-js-artifacts",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      const p = args.path;
      // Only handle relative imports.
      if (!p.startsWith("./") && !p.startsWith("../")) return undefined;
      const importer = args.importer;
      if (!importer) return undefined;
      // Only rewrite imports originating inside a workspace package source
      // tree. Symlinked node_modules paths (Bun's hoisted layout for
      // workspace deps) also count, so the regex covers both
      // `<repo>/plugins/app-wallet/src/...` and
      // `<repo>/node_modules/@elizaos/app-wallet/src/...`.
      if (
        !/[/\\](packages|plugins|cloud)[/\\][^/\\]+([/\\][^/\\]+)?[/\\]src[/\\]/.test(
          importer,
        ) &&
        !/[/\\]node_modules[/\\]@elizaos[/\\][^/\\]+[/\\]src[/\\]/.test(importer)
      ) {
        return undefined;
      }
      const dir = path.dirname(importer);
      const cleaned = p.replace(/\.js$/, "");
      const resolved = path.resolve(dir, cleaned);
      const candidates = [
        `${resolved}.ts`,
        `${resolved}.tsx`,
        path.join(resolved, "index.ts"),
        path.join(resolved, "index.tsx"),
      ];
      for (const candidate of candidates) {
        if (existsSync(candidate)) {
          return { path: candidate, namespace: "file" };
        }
      }
      return undefined;
    });
  },
};

// `@elizaos/*` workspace packages whose `package.json#main` points at
// `dist/index.js` are unbuilt in this checkout. Bun.build's default resolver
// reads `main`, hits a missing file, and aborts the bundle. For workspace
// packages with a `src/index.ts` (the convention across the monorepo) we
// transparently redirect bare-name imports to that source file. Subpath
// imports like `@elizaos/foo/x` are also rerouted to `src/x.ts` (or `.tsx`)
// when the file exists. This avoids forcing a tsc build of dozens of
// upstream packages just to produce the mobile bundle.
const workspaceSrcFallbackPlugin = {
  name: "eliza-mobile-workspace-src-fallback",
  setup(build) {
    const cache = new Map();
    const resolvePackageDir = (pkgName) => {
      if (cache.has(pkgName)) return cache.get(pkgName);
      const pkgPath = path.resolve(
        repoRoot,
        "node_modules",
        ...pkgName.split("/"),
      );
      const result = existsSync(pkgPath) ? pkgPath : null;
      cache.set(pkgName, result);
      return result;
    };
    build.onResolve({ filter: /^@elizaos\// }, (args) => {
      // Don't override packages already handled by the dedupe / capacitor
      // plugins. Order matters: those plugins run earlier in the array.
      if (corePackages.includes(args.path)) return undefined;
      if (/^@elizaos\/capacitor-[^/]+$/.test(args.path)) return undefined;

      const segments = args.path.split("/");
      // `@elizaos/foo` => 2 segments; `@elizaos/foo/bar` => 3+
      const pkgName = `${segments[0]}/${segments[1]}`;
      const subpath = segments.slice(2).join("/");
      const pkgDir = resolvePackageDir(pkgName);
      if (!pkgDir) return undefined;

      // Skip if dist exists — let the default resolver handle it normally.
      if (existsSync(path.join(pkgDir, "dist"))) return undefined;

      // Two layouts to handle: packages with a `src/` directory (the
      // monorepo convention for typescript packages) and packages whose
      // .ts files sit at the package root (the elizaos-plugins convention,
      // e.g. plugin-discord, plugin-telegram, plugin-google).
      const srcDir = existsSync(path.join(pkgDir, "src"))
        ? path.join(pkgDir, "src")
        : pkgDir;

      if (!subpath) {
        for (const name of [
          "index.node.ts",
          "index.ts",
          "index.tsx",
          "index.node.tsx",
        ]) {
          const candidate = path.join(srcDir, name);
          if (existsSync(candidate)) {
            return { path: candidate, namespace: "file" };
          }
        }
        return undefined;
      }

      // Strip an optional `.js` extension (TS source compiles to `.js` so
      // imports like `./foo.js` should resolve to `./foo.ts`).
      const cleaned = subpath.replace(/\.js$/, "");
      const candidates = [
        `${cleaned}.ts`,
        `${cleaned}.tsx`,
        `${cleaned}/index.ts`,
        `${cleaned}/index.tsx`,
        cleaned,
      ];
      for (const candidate of candidates) {
        const full = path.join(srcDir, candidate);
        if (existsSync(full)) {
          return { path: full, namespace: "file" };
        }
      }
      return undefined;
    });
  },
};

// Point Bun.build at a paths-free tsconfig so it doesn't try to resolve
// `react` / `react-dom` to the `.d.ts` files the agent's main tsconfig
// aliases for `tsc --noEmit` typechecking. Those `.d.ts` files contain
// TypeScript-only syntax (`export as namespace React`) that crashes
// the bundler's parser. Workspace `@elizaos/*` resolution is handled by
// the dedupe / capacitor / src-fallback plugins below, not via paths.
const bundlerTsconfig = path.join(agentRoot, "tsconfig.bundle.json");
if (!existsSync(bundlerTsconfig)) {
  console.error(
    `[build-mobile] FATAL: bundler tsconfig not found at ${bundlerTsconfig}`,
  );
  process.exit(1);
}

console.log("[build-mobile] starting Bun.build...");
const buildResult = await Bun.build({
  entrypoints: [entry],
  outdir: outDir,
  naming: "agent-bundle.js",
  target: "bun",
  format: "esm",
  tsconfig: bundlerTsconfig,
  // Don't minify. Bundling is already significant — this is a debugging step
  // to keep stack traces readable. Re-enable selectively if APK size matters.
  minify: false,
  define: {
    "process.env.ELIZA_PLATFORM": JSON.stringify("android"),
    // Disable the `isDirectRun` self-invocation guard in the agent's
    // `runtime/eliza.ts`. After bundling, `import.meta.url` and
    // `process.argv[1]` both resolve to the same bundle path, so the guard
    // (intended to let `bun runtime/eliza.ts` run standalone) fires when the
    // CLI ALSO drives `startEliza`. Two concurrent boots fight over the API
    // port and the second one's stdin-driven chat REPL exits on EOF, taking
    // the whole process down. Defining the marker as `false` flattens the
    // branch at build time.
    "process.env.ELIZA_DISABLE_DIRECT_RUN": JSON.stringify("1"),
  },
  plugins: [
    zodCjsResolverPlugin,
    stubCssPlugin,
    dedupePlugin,
    nativeCapacitorPlugin,
    workspaceSrcFallbackPlugin,
    stripStaleJsArtifactsPlugin,
    stubResolverPlugin,
  ],
});

if (!buildResult.success) {
  console.error("[build-mobile] Bun.build failed:");
  for (const log of buildResult.logs) {
    console.error("  ", log.level, log.message, log.position);
  }
  process.exit(1);
}

const bundlePath = path.join(outDir, "agent-bundle.js");
if (!existsSync(bundlePath)) {
  console.error(
    "[build-mobile] FATAL: agent-bundle.js not produced at",
    bundlePath,
  );
  console.error(
    "[build-mobile] outputs reported:",
    buildResult.outputs.map((o) => o.path),
  );
  process.exit(1);
}
const bundleSize = (await stat(bundlePath)).size;
console.log(
  `[build-mobile] bundle size: ${(bundleSize / 1024 / 1024).toFixed(2)} MB`,
);

// Copy PGlite assets next to the bundle. The bundle's `import.meta.url` will
// resolve to its location at runtime, and `new URL("./pglite.wasm", ...)`
// lands here.
for (const asset of ["pglite.wasm", "initdb.wasm", "pglite.data"]) {
  const src = path.join(pgliteDist, asset);
  if (!existsSync(src)) {
    console.error(`[build-mobile] FATAL: missing ${asset} in ${pgliteDist}`);
    process.exit(1);
  }
  await copyFile(src, path.join(outDir, asset));
  const sz = (await stat(src)).size;
  console.log(
    `[build-mobile] copied ${asset} (${(sz / 1024 / 1024).toFixed(2)} MB)`,
  );
}

// Copy contrib extension tarballs. They live one dir above the bundle on
// device (Phase A handles placement); we surface them in dist-mobile/ so the
// asset pipeline can pick them up.
for (const asset of ["vector.tar.gz", "fuzzystrmatch.tar.gz"]) {
  const src = path.join(pgliteDist, asset);
  if (!existsSync(src)) {
    console.error(`[build-mobile] FATAL: missing ${asset} in ${pgliteDist}`);
    process.exit(1);
  }
  await copyFile(src, path.join(outDir, asset));
  const sz = (await stat(src)).size;
  console.log(`[build-mobile] copied ${asset} (${(sz / 1024).toFixed(1)} KB)`);
}

const manifest = {
  generatedAt: new Date().toISOString(),
  bundle: "agent-bundle.js",
  bunTarget: "bun",
  platform: "android",
  pglite: {
    wasm: "pglite.wasm",
    initdb: "initdb.wasm",
    data: "pglite.data",
    extensions: {
      vector: { file: "vector.tar.gz", expectedAt: "../vector.tar.gz" },
      fuzzystrmatch: {
        file: "fuzzystrmatch.tar.gz",
        expectedAt: "../fuzzystrmatch.tar.gz",
      },
    },
  },
  plugins: {
    core: ["@elizaos/plugin-sql"],
    optional: [
      "@elizaos/plugin-anthropic",
      "@elizaos/plugin-openai",
      "@elizaos/plugin-ollama",
      "@elizaos/plugin-elizacloud",
    ],
  },
  externalsAsStubs: Object.keys(stubAliases),
  notes: [
    "All listed plugins are bundled via static imports in",
    "  eliza/packages/agent/src/runtime/eliza.ts (STATIC_ELIZA_PLUGINS).",
    "The mobile runtime substitutes MOBILE_CORE_PLUGINS for CORE_PLUGINS",
    "when ELIZA_PLATFORM=android.",
  ],
};
await writeFile(
  path.join(outDir, "plugins-manifest.json"),
  JSON.stringify(manifest, null, 2),
);
console.log("[build-mobile] wrote plugins-manifest.json");

console.log("[build-mobile] done.");
console.log("[build-mobile] outputs:");
for (const file of (await readdir(outDir)).sort()) {
  const s = await stat(path.join(outDir, file));
  console.log(`  ${file.padEnd(28)} ${(s.size / 1024).toFixed(1)} KB`);
}
