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
  rename,
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

// Target selection. `--target=android` (default) preserves existing behavior;
// `--target=ios` swaps in iOS-specific stubs and sets ELIZA_PLATFORM=ios at
// bundle time. `--target=ios-jsc` produces an ESM bundle for the iOS
// JSContext runtime: Bun.build runs with target=browser (no inlined Bun
// CJS-on-V8 shims) and a polyfill prefix from
// native/ios-bun-port/polyfill/dist/polyfill-prefix.js is concatenated on
// top to install Bun + Node module shims over globalThis.__MILADY_BRIDGE__.
const targetArg = (process.argv.find((a) => a.startsWith("--target=")) ?? "")
  .split("=")[1];
const TARGET = targetArg || process.env.ELIZA_MOBILE_TARGET || "android";
if (TARGET !== "android" && TARGET !== "ios" && TARGET !== "ios-jsc") {
  console.error(
    `[build-mobile] FATAL: unknown --target=${TARGET}; expected 'android', 'ios', or 'ios-jsc'`,
  );
  process.exit(1);
}

const OUT_DIRS = {
  android: "dist-mobile",
  ios: "dist-mobile-ios",
  "ios-jsc": "dist-mobile-ios-jsc",
};
const outDir = path.join(agentRoot, OUT_DIRS[TARGET]);
const stubsDir = path.join(here, "mobile-stubs");
const entry = path.join(agentRoot, "src", "bin.ts");

console.log("[build-mobile] target:", TARGET);
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
  console.log("[build-mobile] generating @elizaos/shared i18n keyword data...");
  const result = spawnSync(
    "bun",
    ["run", "--cwd", path.join(repoRoot, "packages", "shared"), "build:i18n"],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    console.error("[build-mobile] FATAL: failed to generate i18n keyword data");
    process.exit(1);
  }
}

function findPgliteDist() {
  // pglite.wasm + pglite.data MUST match the @electric-sql/pglite version
  // that the bundled agent JS resolves at runtime — they're a triple
  // (engine + filesystem image + JS shim). The agent imports
  // `@electric-sql/pglite` transitively through `@elizaos/plugin-sql`
  // which pins `^0.4.0`. Bun's bundler picks the matching workspace
  // resolution; we just need to ship the same version's `.wasm`/`.data`.
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
      "node_modules",
      "@electric-sql",
      "pglite",
      "dist",
    ),
    path.join(repoRoot, "node_modules", "@electric-sql", "pglite", "dist"),
  ];
  const bunDir = path.join(repoRoot, "node_modules", ".bun");
  if (existsSync(bunDir)) {
    // Sort `.bun` entries by version DESCENDING so the newest pglite (the
    // one plugin-sql currently pins) wins. The pin is `^0.4.0` today;
    // `0.4.5 < 0.4.10` lexicographically, so use a numeric-aware compare.
    const sortedEntries = readdirSyncSafe(bunDir)
      .filter((e) => e.startsWith("@electric-sql+pglite@"))
      .sort((a, b) => {
        const va = a
          .replace(/^@electric-sql\+pglite@/, "")
          .split(".")
          .map((n) => Number.parseInt(n, 10) || 0);
        const vb = b
          .replace(/^@electric-sql\+pglite@/, "")
          .split(".")
          .map((n) => Number.parseInt(n, 10) || 0);
        for (let i = 0; i < Math.max(va.length, vb.length); i++) {
          const da = va[i] ?? 0;
          const db = vb[i] ?? 0;
          if (da !== db) return db - da;
        }
        return 0;
      });
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
  // `node:sqlite` is a Node.js 22+ built-in (DatabaseSync) that
  // `packages/app-core/src/api/training-benchmarks.ts` imports at module
  // top level. Bun 1.3.x on arm64-Android does not yet implement it, so
  // the unstubbed import bombs on first agent boot:
  //   error: Could not resolve: "node:sqlite". Maybe you need to "bun install"?
  //   at /data/data/<pkg>/files/agent/agent-bundle.js:NNNNN
  // The benchmarks endpoint has no mobile use case — it reads + writes
  // training-run JSONL from the desktop training pipeline. Swap the
  // import for `empty.cjs` so the bundle still loads; route handlers
  // that touch the missing API will return undefined-method errors
  // through the existing connector-route error path, which is correct
  // behaviour for a no-op surface on mobile.
  "node:sqlite": path.join(stubsDir, "empty.cjs"),
  // `@node-rs/argon2` ships platform-specific native `.node` binaries. If left
  // unstubbed on a macOS build host, Bun emits `argon2.darwin-arm64...node`
  // into dist-mobile, which is both unusable on Android and unacceptable for a
  // portable mobile payload. Mobile does not run desktop password-auth routes,
  // so fail closed if anything reaches this surface.
  "@node-rs/argon2": path.join(stubsDir, "argon2.cjs"),
  "@types/react": path.join(stubsDir, "null-plugin.cjs"),
  "@types/react/jsx-runtime": path.join(stubsDir, "null-plugin.cjs"),
  "@types/react/jsx-dev-runtime": path.join(stubsDir, "null-plugin.cjs"),
  "node-llama-cpp": path.join(stubsDir, "node-llama-cpp.cjs"),
  "@node-llama-cpp/linux-x64": path.join(stubsDir, "node-llama-cpp.cjs"),
  "@node-llama-cpp/linux-arm64": path.join(stubsDir, "node-llama-cpp.cjs"),
  "@node-llama-cpp/mac-arm64": path.join(stubsDir, "node-llama-cpp.cjs"),
  "@node-llama-cpp/mac-x64": path.join(stubsDir, "node-llama-cpp.cjs"),
  "@node-llama-cpp/win-x64": path.join(stubsDir, "node-llama-cpp.cjs"),
  // llama-cpp-capacitor is the WebView-side JNI binding for the Capacitor
  // mobile build. The bun-side AOSP agent uses bun:ffi against libllama.so
  // directly via aosp-llama-adapter.ts, never this package — but Bun.build
  // still has to resolve the dynamic import in
  // packages/native-plugins/llama/src/capacitor-llama-adapter.ts.
  "llama-cpp-capacitor": path.join(stubsDir, "llama-cpp-capacitor.cjs"),
  "onnxruntime-node": path.join(stubsDir, "onnxruntime-node.cjs"),
  "@huggingface/transformers": path.join(
    stubsDir,
    "huggingface-transformers.cjs",
  ),
  "puppeteer-core": path.join(stubsDir, "puppeteer-core.cjs"),
  "pty-manager": path.join(stubsDir, "pty-manager.cjs"),
  sharp: path.join(stubsDir, "sharp.cjs"),
  canvas: path.join(stubsDir, "canvas.cjs"),
  // `zlib-sync` is a synchronous prebuild-aware zlib wrapper that ships
  // `require("./build/Release/zlib_sync.node")` and depends on the host's
  // `node-gyp` install spitting out a per-platform `.node` artifact. Discord
  // pulls it in transitively for opportunistic compression. The mobile
  // bundle has no native build step, no Discord runtime path, and no
  // ELIZA_PLATFORM=android codepath that needs sync zlib — fall back to
  // the throw-on-call stub.
  "zlib-sync": path.join(stubsDir, "null-plugin.cjs"),
  // `@elizaos/core/testing` re-exports `real-connector.ts`, which calls
  // `await import("dotenv")` at module top level. Bun's bundler then
  // refuses to merge any module that does `require("@elizaos/core")`
  // because the resulting CJS-style namespace object would force the
  // require'er to wait on the TLA. Mobile never runs the integration-test
  // harness, so swap the entire testing surface for an empty stub.
  "@elizaos/core/testing": path.join(stubsDir, "empty.cjs"),
  // `@snazzah/davey` is discord.js's DAVE-protocol voice codec — a
  // napi-rs native binding with NO Android prebuild. discord.js statically
  // requires it through its voice subpath; the bundle inlines the
  // platform-dispatch loader, which then dies with `Cannot find native
  // binding` at runtime even though the agent never opens a voice call.
  // Stub the whole package: discord.js's voice path silently degrades to
  // unencrypted UDP (fine for our purposes — the agent is text-only).
  "@snazzah/davey": path.join(stubsDir, "null-plugin.cjs"),
  // `@napi-rs/keyring` is the OS-keychain master-key resolver in
  // `@elizaos/vault`. No Android prebuild ships, and the bundled
  // platform-dispatch loader fails at runtime with `Cannot find native
  // binding` BEFORE vault's defensive try/catch around `await import` can
  // catch it. The agent's master-key path falls through to
  // `ELIZA_VAULT_PASSPHRASE` / in-memory keys; ElizaAgentService can mint
  // a per-boot passphrase if needed. Stub keeps the bundle building.
  "@napi-rs/keyring": path.join(stubsDir, "null-plugin.cjs"),
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

// iOS-specific overrides. The iOS Bun port (see native/ios-bun-port/) forbids
// `child_process` / `Bun.spawn` (kernel sandbox), restricts `bun:ffi` to
// statically-linked symbols, and routes `os.homedir()` through env vars set by
// ElizaBunRuntime.swift. These stubs surface the platform constraints as JS
// runtime errors rather than module-load crashes.
if (TARGET === "ios" || TARGET === "ios-jsc") {
  nativeStubs["node:child_process"] = path.join(stubsDir, "ios-child-process.cjs");
  nativeStubs["child_process"] = path.join(stubsDir, "ios-child-process.cjs");
  nativeStubs["node:os"] = path.join(stubsDir, "ios-os.cjs");
  // Note: `bun:ffi` is provided natively by the iOS Bun runtime; the
  // ios-ffi.cjs stub only loads in dev/desktop fallbacks where this bundle
  // is being run outside the iOS port. We do NOT remap `bun:ffi` here so
  // the native implementation wins on iOS device builds.
}

// ios-jsc adds throw-on-use stubs for Node built-ins not exposed by the
// JSContext bridge v1 surface, plus a passthrough DNS shim (URLSession
// resolves DNS for us, so dns.lookup just returns the input). bun:ffi is
// remapped to the existing ios-ffi.cjs stub here — there is no native
// bun:ffi inside JSContext, unlike the iOS Bun port target.
if (TARGET === "ios-jsc") {
  const throwStub = path.join(stubsDir, "ios-jsc-throw.cjs");
  const dnsStub = path.join(stubsDir, "ios-jsc-dns.cjs");
  nativeStubs["node:net"] = throwStub;
  nativeStubs["net"] = throwStub;
  nativeStubs["node:tls"] = throwStub;
  nativeStubs["tls"] = throwStub;
  nativeStubs["node:dgram"] = throwStub;
  nativeStubs["dgram"] = throwStub;
  nativeStubs["node:cluster"] = throwStub;
  nativeStubs["cluster"] = throwStub;
  nativeStubs["node:worker_threads"] = throwStub;
  nativeStubs["worker_threads"] = throwStub;
  nativeStubs["node:dns"] = dnsStub;
  nativeStubs["dns"] = dnsStub;
  nativeStubs["node:dns/promises"] = dnsStub;
  nativeStubs["dns/promises"] = dnsStub;
  nativeStubs["bun:ffi"] = path.join(stubsDir, "ios-ffi.cjs");
}

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
  // `plugin-streaming` carries the TTS / SSE plumbing for desktop +
  // server. Mobile never runs the streaming worker pool — the agent
  // statically imports `streamManager` and `handleTtsRoutes`, so we
  // stub the package with the same null-plugin proxy. The runtime
  // log otherwise spams `[eliza-api] Failed to load
  // @elizaos/plugin-streaming destinations: ResolveMessage: Cannot
  // find module '@elizaos/plugin-streaming'` on every chat turn.
  "@elizaos/plugin-streaming": path.join(stubsDir, "null-plugin.cjs"),
};

const stubAliases = { ...nativeStubs, ...optionalPluginStubs };

// `@elizaos/core/src/index.node.ts` does `export * from "./testing"`, and
// that subtree's `real-connector.ts:24` calls `await import("dotenv")` at
// module top level. Bun's bundler then refuses every CJS-style
// `require("@elizaos/core")` upstream (eliza-plugin.ts, embedding-manager-
// support, etc.) because the resulting namespace would have to wait on
// the TLA, which CJS can't express. Mobile never runs the integration
// test harness — strip the entire testing subtree at bundle time so the
// TLA chain never enters the graph.
const coreTestingStripPlugin = {
  name: "eliza-mobile-strip-core-testing",
  setup(build) {
    const emptyStub = path.join(stubsDir, "empty.cjs");
    build.onResolve({ filter: /^\.\.?\/testing(\/.*)?$/ }, (args) => {
      if (!args.importer) return undefined;
      const norm = args.importer.replace(/\\/g, "/");
      if (norm.includes("/packages/core/src/")) {
        return { path: emptyStub, namespace: "file" };
      }
      return undefined;
    });
    build.onResolve({ filter: /testing\/real-connector/ }, () => ({
      path: emptyStub,
      namespace: "file",
    }));
  },
};

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
  //
  // The on-disk layout is `plugins/plugin-sql/src/index.node.ts`. (An earlier
  // refactor staged a `plugins/plugin-sql/typescript/` mirror; that's gone
  // now and the path here was stale.)
  "@elizaos/plugin-sql": path.resolve(
    repoRoot,
    "plugins",
    "plugin-sql",
    "src",
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

// host-specific UI modules and any other workspace UI module that
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
        !/[/\\]node_modules[/\\]@elizaos[/\\][^/\\]+[/\\]src[/\\]/.test(
          importer,
        )
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

// ios-jsc uses target=browser so Bun.build does NOT inline Bun's
// CJS-on-V8 shims; the polyfill prefix from
// native/ios-bun-port/polyfill/ supplies Bun + Node module shims at
// runtime over globalThis.__MILADY_BRIDGE__. The platform define
// stays "ios" (so runtime feature gates that check ELIZA_PLATFORM=='ios'
// fire), with a parallel ELIZA_RUNTIME='ios-jsc' for code that needs to
// distinguish the JSContext + bridge environment from a real Bun runtime.
const bunBuildTarget = TARGET === "ios-jsc" ? "browser" : "bun";
const platformDefineValue = TARGET === "ios-jsc" ? "ios" : TARGET;

// Browser-targeted Bun.build refuses Node built-ins outright; the polyfill
// resolves these at runtime via __MILADY_BRIDGE__, so we mark them external
// and let the imports survive into the output. The list mirrors the modules
// the polyfill exposes plus the long tail that workspace dependencies pull
// in (timers, module, etc.). Anything not handled by the polyfill will
// surface as a clear `require is not defined` / `Cannot find module` at
// runtime — preferable to silently dropping the import at bundle time.
const iosJscExternals =
  TARGET === "ios-jsc"
    ? [
        "node:fs",
        "node:fs/promises",
        "node:path",
        "node:os",
        "node:crypto",
        "node:url",
        "node:util",
        "node:stream",
        "node:stream/web",
        "node:stream/promises",
        "node:stream/consumers",
        "node:buffer",
        "node:events",
        "node:http",
        "node:https",
        "node:zlib",
        "node:querystring",
        "node:assert",
        "node:assert/strict",
        "node:async_hooks",
        "node:child_process",
        "node:net",
        "node:tls",
        "node:dgram",
        "node:dns",
        "node:dns/promises",
        "node:cluster",
        "node:worker_threads",
        "node:perf_hooks",
        "node:timers",
        "node:timers/promises",
        "node:string_decoder",
        "node:readline",
        "node:tty",
        "node:vm",
        "node:module",
        "node:process",
        "node:punycode",
        "node:console",
        "node:inspector",
        "node:test",
        "node:sqlite",
        // Bare-name forms too — Bun.build treats these as distinct
        // specifiers from the node:-prefixed forms.
        "module",
        "fs",
        "fs/promises",
        "path",
        "os",
        "crypto",
        "url",
        "util",
        "stream",
        "stream/web",
        "stream/promises",
        "buffer",
        "events",
        "http",
        "https",
        "zlib",
        "querystring",
        "assert",
        "child_process",
        "net",
        "tls",
        "dgram",
        "dns",
        "dns/promises",
        "cluster",
        "worker_threads",
        "perf_hooks",
        "timers",
        "timers/promises",
        "string_decoder",
        "readline",
        "tty",
        "vm",
        "process",
        "punycode",
        "console",
        // bun:* specifiers — the polyfill exposes Bun.* under globalThis.Bun,
        // and bun:sqlite / bun:ffi resolve through the polyfill module map.
        "bun:sqlite",
        // bun:ffi is intentionally NOT external — it's already mapped to
        // ios-ffi.cjs via stubResolverPlugin and inlined for ios-jsc.
      ]
    : undefined;

console.log("[build-mobile] starting Bun.build...");
const buildResult = await Bun.build({
  entrypoints: [entry],
  outdir: outDir,
  naming: "[dir]/[name].[ext]",
  target: bunBuildTarget,
  format: "esm",
  ...(iosJscExternals ? { external: iosJscExternals } : {}),
  tsconfig: bundlerTsconfig,
  // Don't minify. Bundling is already significant — this is a debugging step
  // to keep stack traces readable. Re-enable selectively if APK size matters.
  minify: false,
  define: {
    "process.env.ELIZA_PLATFORM": JSON.stringify(platformDefineValue),
    // Disable the `isDirectRun` self-invocation guard in the agent's
    // `runtime/eliza.ts`. After bundling, `import.meta.url` and
    // `process.argv[1]` both resolve to the same bundle path, so the guard
    // (intended to let `bun runtime/eliza.ts` run standalone) fires when the
    // CLI ALSO drives `startEliza`. Two concurrent boots fight over the API
    // port and the second one's stdin-driven chat REPL exits on EOF, taking
    // the whole process down. Defining the marker as `false` flattens the
    // branch at build time.
    "process.env.ELIZA_DISABLE_DIRECT_RUN": JSON.stringify("1"),
    // ios-jsc-only defines. Code can branch on ELIZA_RUNTIME='ios-jsc'
    // to detect the JSContext + bridge runtime, and the global flags let
    // the polyfill prefix flip behaviour without re-reading process.env
    // (the polyfill is loaded before process.env is fully simulated).
    ...(TARGET === "ios-jsc"
      ? {
          "process.env.ELIZA_RUNTIME": JSON.stringify("ios-jsc"),
          "globalThis.__ELIZA_IOS_JSC__": JSON.stringify(true),
          "globalThis.__ELIZA_BRIDGE_VERSION_REQUIRED__": JSON.stringify("v1"),
        }
      : {}),
  },
  plugins: [
    coreTestingStripPlugin,
    zodCjsResolverPlugin,
    stubCssPlugin,
    dedupePlugin,
    nativeCapacitorPlugin,
    workspaceSrcFallbackPlugin,
    stripStaleJsArtifactsPlugin,
    stubResolverPlugin,
    // ios-jsc: actively mark Node built-ins as external via onResolve so
    // Bun.build's browser target stops substituting its incomplete browser
    // polyfills (e.g. node:url without pathToFileURL). The polyfill prefix
    // resolves these at runtime via __MILADY_BRIDGE__. Comes AFTER
    // stubResolverPlugin so explicit stubs (ios-jsc-throw, ios-os, etc.)
    // still win for the modules we want to inline.
    ...(TARGET === "ios-jsc"
      ? [
          {
            name: "ios-jsc-node-externals",
            setup(build) {
              const externalSet = new Set(iosJscExternals ?? []);
              build.onResolve({ filter: /.*/ }, (args) => {
                if (externalSet.has(args.path)) {
                  return { path: args.path, external: true };
                }
                return undefined;
              });
            },
          },
        ]
      : []),
  ],
});

if (!buildResult.success) {
  console.error("[build-mobile] Bun.build failed:");
  for (const log of buildResult.logs) {
    console.error("  ", log.level, log.message, log.position);
  }
  process.exit(1);
}

// ios-jsc ships the bundle as `agent-bundle-ios.js` (matches the iOS
// app's loader expectation); android + ios-bun stay on `agent-bundle.js`.
const bundleFilename =
  TARGET === "ios-jsc" ? "agent-bundle-ios.js" : "agent-bundle.js";
const bundlePath = path.join(outDir, bundleFilename);
const defaultEntryPath = path.join(outDir, "bin.js");
if (!existsSync(bundlePath) && existsSync(defaultEntryPath)) {
  await rename(defaultEntryPath, bundlePath);
}
if (!existsSync(bundlePath)) {
  console.error(
    `[build-mobile] FATAL: ${bundleFilename} not produced at`,
    bundlePath,
  );
  console.error(
    "[build-mobile] outputs reported:",
    buildResult.outputs.map((o) => o.path),
  );
  process.exit(1);
}
// Bun.build occasionally renames default-export bindings (e.g. `v4` from
// uuid → `default10`) but loses the binding when the source module is
// stubbed by `externalsAsStubs` or has a multi-entry-point exports map.
// `apply*Override3` collisions come from the same path: a stubbed plugin
// (e.g. `@elizaos/plugin-whatsapp`) leaves a numbered alias unbound.
// Same root cause produces the `AutonomyService failed to start:
// AutonomyService2 is not defined` warning at boot — the dedup'd alias
// for the autonomy service class never gets bound when the consumer
// `startAndRegisterAutonomyService2` runs before the second copy's init.
//
// The bundle still references these identifiers at runtime, so chat
// completion crashes with "default10 is not defined". Prepend a polyfill
// header that defines the few known offenders. Each one is either a uuid
// generator (use the platform crypto), a no-op for stubbed plugins, or
// (for AutonomyService2) an alias to the original class that DID get
// bound by `init_service2`.
//
// The right long-term fix is to make Bun.build emit consistent bindings
// for stubbed modules; until then, this prefix keeps the agent runnable.
//
// The polyfill is split into two phases:
//   1. The header is prepended at the top of the bundle. These are
//      `var X` declarations that get hoisted; consumers further down the
//      bundle that read them before the underlying module's init runs
//      see the polyfill value instead of `undefined`.
//   2. The footer `if`-guard runs AFTER the bundle has finished loading
//      (so the original module inits have run and `AutonomyService` etc.
//      are populated). It reassigns the dedup'd alias to point at the
//      now-bound original where one exists. No-op when the original
//      isn't there either.
const bundleSrc = await Bun.file(bundlePath).text();
// `AutonomyService2` is the dedup'd consumer-side alias for the
// autonomy Service class. The class itself (`class AutonomyService
// extends Service { static async start(runtime) {...} }`) lives in a
// lazy `init_service2()` body that doesn't run until something pulls
// the autonomy module — but `startAndRegisterAutonomyService2` reads
// `AutonomyService2` BEFORE that init runs. The bundle ships the alias
// without a binding, so the runtime sees `AutonomyService2 is not
// defined` at boot.
//
// Polyfill it as a no-op service class so `startAndRegisterAutonomyService2`
// just returns null. Autonomy is opt-in, so a no-op class is safe.
//
// Generic phase: scan the bundle for identifiers that match known
// rename patterns (`defaultN`, `applyXxxNN`) and ensure every called-but-
// undeclared one gets a polyfill. UUID-shaped renames (most `defaultN`)
// fall back to crypto.randomUUID. apply* renames fall back to no-ops.
// Real declarations in the bundle shadow these polyfills via `var`
// hoisting + same-name redeclaration semantics.
function scanUndeclaredRenames(src) {
  const declRegex =
    /(?:\bvar\s+|\blet\s+|\bconst\s+|\bfunction\s+|\bclass\s+)([A-Za-z_$][\w$]*)/g;
  const declared = new Set();
  for (const m of src.matchAll(declRegex)) declared.add(m[1]);
  const candidateRegex =
    /\b(default\d+|apply[A-Za-z]+Override\d+|[A-Za-z]+Service\d+)\b/g;
  const seen = new Set();
  const undeclaredDefaults = new Set();
  const undeclaredApplies = new Set();
  const undeclaredServices = new Set();
  for (const m of src.matchAll(candidateRegex)) {
    const name = m[1];
    if (seen.has(name)) continue;
    seen.add(name);
    if (declared.has(name)) continue;
    if (name.startsWith("default")) undeclaredDefaults.add(name);
    else if (name.startsWith("apply")) undeclaredApplies.add(name);
    else undeclaredServices.add(name);
  }
  return { undeclaredDefaults, undeclaredApplies, undeclaredServices };
}

const renames = scanUndeclaredRenames(bundleSrc);
const polyfillLines = [
  "// auto-injected polyfills for Bun.build identifier-resolution gaps",
];
// Always-on: the few hand-curated overrides that need specific shapes.
polyfillLines.push("var default10 = () => globalThis.crypto.randomUUID();");
polyfillLines.push("var applyWhatsAppQrOverride3 = () => {};");
polyfillLines.push("var applySignalQrOverride3 = () => {};");
polyfillLines.push(
  "var AutonomyService2 = class AutonomyServicePolyfill {\n" +
    "  static serviceType = 'AUTONOMY';\n" +
    "  static async start(_runtime) { return null; }\n" +
    "  async stop() {}\n" +
    "};",
);
const SKIP_DEFAULTS = new Set(["default10"]);
const SKIP_APPLIES = new Set([
  "applyWhatsAppQrOverride3",
  "applySignalQrOverride3",
]);
const SKIP_SERVICES = new Set(["AutonomyService2"]);
for (const name of renames.undeclaredDefaults) {
  if (SKIP_DEFAULTS.has(name)) continue;
  polyfillLines.push(`var ${name} = () => globalThis.crypto.randomUUID();`);
}
for (const name of renames.undeclaredApplies) {
  if (SKIP_APPLIES.has(name)) continue;
  polyfillLines.push(`var ${name} = () => {};`);
}
for (const name of renames.undeclaredServices) {
  if (SKIP_SERVICES.has(name)) continue;
  polyfillLines.push(
    `var ${name} = class ${name}Polyfill { static async start(_runtime) { return null; } async stop() {} };`,
  );
}
console.log(
  `[build-mobile] polyfill: ${renames.undeclaredDefaults.size} default*, ` +
    `${renames.undeclaredApplies.size} apply*, ` +
    `${renames.undeclaredServices.size} *Service* identifiers covered`,
);
const polyfillHeader = `${polyfillLines.join("\n")}\n`;
const polyfillFooter = "";

// ios-jsc: prepend the JSContext polyfill from
// native/ios-bun-port/polyfill/dist/polyfill-prefix.js (built in parallel
// by the polyfill agent). The prefix installs Bun + Node module shims
// over globalThis.__MILADY_BRIDGE__. If the file is missing (parallel
// build hasn't finished yet) emit a banner comment and proceed so the
// pipeline keeps moving — the polyfill can be concatenated at install
// time on the device side.
let iosJscPolyfillSrc = "";
let iosJscPolyfillBundled = false;
if (TARGET === "ios-jsc") {
  const polyfillPath = path.resolve(
    repoRoot,
    "..",
    "native",
    "ios-bun-port",
    "polyfill",
    "dist",
    "polyfill-prefix.js",
  );
  if (existsSync(polyfillPath)) {
    iosJscPolyfillSrc = await Bun.file(polyfillPath).text();
    iosJscPolyfillBundled = true;
    console.log(
      `[build-mobile] prepended ios-jsc polyfill (${(iosJscPolyfillSrc.length / 1024).toFixed(1)} KB) from ${polyfillPath}`,
    );
  } else {
    iosJscPolyfillSrc =
      "// WARNING: ios-jsc polyfill prefix not found at " +
      polyfillPath +
      "\n" +
      "// This bundle assumes the polyfill prefix is prepended at install time.\n" +
      "// Without it, __MILADY_BRIDGE__-backed Bun + Node shims will be missing\n" +
      "// and the agent will crash at first `require('node:fs')` / `Bun.serve()`.\n";
    console.warn(
      `[build-mobile] WARNING: ios-jsc polyfill missing at ${polyfillPath}; ` +
        "emitting agent code with a banner comment only. " +
        "Prepend the polyfill at install time before evaluating in JSContext.",
    );
  }
}

// The bridge-version guard is appended after the polyfill so the polyfill
// itself defines __MILADY_BRIDGE__ usage; the guard runs before the agent
// bundle and aborts fast on a version mismatch.
const iosJscBridgeCheck =
  TARGET === "ios-jsc"
    ? "if (typeof globalThis.__MILADY_BRIDGE__ === 'undefined') {\n" +
      "  throw new Error('[ios-jsc] __MILADY_BRIDGE__ is not installed; the Swift Capacitor host must inject it before evaluating this bundle.');\n" +
      "}\n" +
      "if (globalThis.__MILADY_BRIDGE__ && globalThis.__MILADY_BRIDGE__.version && globalThis.__MILADY_BRIDGE__.version !== 'v1') {\n" +
      "  throw new Error('[ios-jsc] __MILADY_BRIDGE__ version mismatch: bundle requires v1, host provided ' + globalThis.__MILADY_BRIDGE__.version);\n" +
      "}\n"
    : "";

let prefixed;
if (bundleSrc.startsWith("#!")) {
  const nlIndex = bundleSrc.indexOf("\n");
  prefixed =
    bundleSrc.slice(0, nlIndex + 1) +
    iosJscPolyfillSrc +
    iosJscBridgeCheck +
    polyfillHeader +
    bundleSrc.slice(nlIndex + 1) +
    polyfillFooter;
} else {
  prefixed =
    iosJscPolyfillSrc +
    iosJscBridgeCheck +
    polyfillHeader +
    bundleSrc +
    polyfillFooter;
}
await Bun.write(bundlePath, prefixed);

const nativeNodeOutputs = (await readdir(outDir)).filter((file) =>
  file.endsWith(".node"),
);
if (nativeNodeOutputs.length > 0) {
  console.error(
    `[build-mobile] FATAL: native Node addon(s) leaked into the ${TARGET} mobile payload:`,
    nativeNodeOutputs.join(", "),
  );
  console.error(
    "[build-mobile] Add an explicit mobile stub for the package that emitted the native addon.",
  );
  process.exit(1);
}

const bundleSize = (await stat(bundlePath)).size;
console.log(
  `[build-mobile] bundle size: ${(bundleSize / 1024 / 1024).toFixed(2)} MB (with polyfill prefix)`,
);

// Copy PGlite assets next to the bundle. The bundle's `import.meta.url` will
// resolve to its location at runtime, and `new URL("./pglite.wasm", ...)`
// lands here.
// `initdb.wasm` is optional. Older pglite (≤0.3.x) inlined the initdb
// stage into `pglite.wasm`; only 0.4.x onwards split it back out as a
// separate asset. Keeping it optional lets the same bundle script work
// against either pglite drop without forcing a transitive bump.
const PGLITE_REQUIRED = new Set(["pglite.wasm", "pglite.data"]);
for (const asset of ["pglite.wasm", "initdb.wasm", "pglite.data"]) {
  const src = path.join(pgliteDist, asset);
  if (!existsSync(src)) {
    if (PGLITE_REQUIRED.has(asset)) {
      console.error(`[build-mobile] FATAL: missing ${asset} in ${pgliteDist}`);
      process.exit(1);
    }
    console.log(
      `[build-mobile] skipping ${asset} (not present in pglite ${pgliteDist}; assumed inlined upstream)`,
    );
    continue;
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
  bundle: bundleFilename,
  bunTarget: bunBuildTarget,
  platform: TARGET,
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
    core: ["@elizaos/plugin-sql", "@elizaos/plugin-background-runner"],
    aospOnly: [
      "@elizaos/app-wifi",
      "@elizaos/app-contacts",
      "@elizaos/app-phone",
      "@elizaos/plugin-shell",
      "@elizaos/plugin-coding-tools",
      "agent-orchestrator",
    ],
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

// ios-jsc gets an additional `manifest.json` next to the bundle for the
// Swift Capacitor loader: it lists the bridge version the bundle needs
// and a sha256 fingerprint so the host can verify the asset on launch.
if (TARGET === "ios-jsc") {
  const finalBundleBytes = await Bun.file(bundlePath).bytes();
  const sha256 = new Bun.CryptoHasher("sha256")
    .update(finalBundleBytes)
    .digest("hex");
  const iosJscManifest = {
    target: "ios-jsc",
    bundle: bundleFilename,
    bundle_size_bytes: finalBundleBytes.length,
    bridge_version_required: "v1",
    polyfill_bundled: iosJscPolyfillBundled,
    sha256,
    generatedAt: new Date().toISOString(),
  };
  await writeFile(
    path.join(outDir, "manifest.json"),
    JSON.stringify(iosJscManifest, null, 2),
  );
  console.log(
    `[build-mobile] wrote manifest.json (sha256=${sha256.slice(0, 16)}..., polyfill_bundled=${iosJscPolyfillBundled})`,
  );
}

console.log("[build-mobile] done.");
console.log("[build-mobile] outputs:");
for (const file of (await readdir(outDir)).sort()) {
  const s = await stat(path.join(outDir, file));
  console.log(`  ${file.padEnd(28)} ${(s.size / 1024).toFixed(1)} KB`);
}
