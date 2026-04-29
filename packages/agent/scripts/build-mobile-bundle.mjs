#!/usr/bin/env bun
// build-mobile-bundle.mjs — produce the on-device agent payload.
//
// Output layout (consumed by the Phase A asset pipeline):
//
//   eliza/packages/agent/dist-mobile/
//     agent-bundle.js              the actual bun-runnable payload
//     pglite.wasm                  PGlite WebAssembly module
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
//     - "./pglite.data"            => same dir as the bundle
//     - "../vector.tar.gz"         => one dir above the bundle
//     - "../fuzzystrmatch.tar.gz"  => one dir above the bundle
//   After `Bun.build`, `import.meta.url` becomes the bundle's path, so we
//   ship the four files alongside it and the asset pipeline mounts them so
//   the relative paths land. Phase A is responsible for placing the .tar.gz
//   files at parent-of-bundle on the device.

import {
  copyFile,
  mkdir,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentRoot = path.resolve(here, "..");
const repoRoot = path.resolve(agentRoot, "..", "..", "..");
const outDir = path.join(agentRoot, "dist-mobile");
const stubsDir = path.join(here, "mobile-stubs");
const entry = path.join(agentRoot, "src", "bin.ts");

console.log("[build-mobile] agent root:", agentRoot);
console.log("[build-mobile] output dir:", outDir);

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

function findPgliteDist() {
  const candidates = [
    path.join(repoRoot, "node_modules", "@electric-sql", "pglite", "dist"),
  ];
  const bunDir = path.join(repoRoot, "node_modules", ".bun");
  if (existsSync(bunDir)) {
    for (const entry of readdirSyncSafe(bunDir)) {
      if (entry.startsWith("@electric-sql+pglite@")) {
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
// in the output; `MILADY_PLATFORM=android` would then fail at runtime when
// the mobile bun process can't resolve the missing package. A plugin onResolve
// that maps the bare specifier to the stub path keeps the resolution pure.
// Native deps without an Android prebuild — replaced with throw-on-call shims.
const nativeStubs = {
  "node-llama-cpp": path.join(stubsDir, "node-llama-cpp.cjs"),
  "@node-llama-cpp/linux-x64": path.join(stubsDir, "node-llama-cpp.cjs"),
  "@node-llama-cpp/linux-arm64": path.join(stubsDir, "node-llama-cpp.cjs"),
  "@node-llama-cpp/mac-arm64": path.join(stubsDir, "node-llama-cpp.cjs"),
  "@node-llama-cpp/mac-x64": path.join(stubsDir, "node-llama-cpp.cjs"),
  "@node-llama-cpp/win-x64": path.join(stubsDir, "node-llama-cpp.cjs"),
  "onnxruntime-node": path.join(stubsDir, "onnxruntime-node.cjs"),
  "@huggingface/transformers": path.join(stubsDir, "huggingface-transformers.cjs"),
  "puppeteer-core": path.join(stubsDir, "puppeteer-core.cjs"),
  "pty-manager": path.join(stubsDir, "pty-manager.cjs"),
  sharp: path.join(stubsDir, "sharp.cjs"),
  canvas: path.join(stubsDir, "canvas.cjs"),
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
  "@elizaos/plugin-cron": path.join(stubsDir, "null-plugin.cjs"),
  "@elizaos/plugin-cli": path.join(stubsDir, "null-plugin.cjs"),
};

const stubAliases = { ...nativeStubs, ...optionalPluginStubs };

const stubResolverPlugin = {
  name: "milady-mobile-stubs",
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
// at `../typescript/src/index.node.ts`, but `@elizaos/plugin-sql` (and other
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

const dedupeTargets = {
  "@elizaos/core": path.resolve(
    repoRoot,
    "eliza",
    "packages",
    "typescript",
    "src",
    "index.node.ts",
  ),
  "@elizaos/shared": path.resolve(
    repoRoot,
    "eliza",
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
    "eliza",
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
  name: "milady-mobile-core-dedupe",
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

console.log("[build-mobile] starting Bun.build...");
const buildResult = await Bun.build({
  entrypoints: [entry],
  outdir: outDir,
  naming: "agent-bundle.js",
  target: "bun",
  format: "esm",
  // Don't minify. Bundling is already significant — this is a debugging step
  // to keep stack traces readable. Re-enable selectively if APK size matters.
  minify: false,
  define: {
    "process.env.MILADY_PLATFORM": JSON.stringify("android"),
    // Disable the `isDirectRun` self-invocation guard in the agent's
    // `runtime/eliza.ts`. After bundling, `import.meta.url` and
    // `process.argv[1]` both resolve to the same bundle path, so the guard
    // (intended to let `bun runtime/eliza.ts` run standalone) fires when the
    // CLI ALSO drives `startEliza`. Two concurrent boots fight over the API
    // port and the second one's stdin-driven chat REPL exits on EOF, taking
    // the whole process down. Defining the marker as `false` flattens the
    // branch at build time.
    "process.env.MILADY_DISABLE_DIRECT_RUN": JSON.stringify("1"),
  },
  plugins: [dedupePlugin, stubResolverPlugin],
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
for (const asset of ["pglite.wasm", "pglite.data"]) {
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
    "when MILADY_PLATFORM=android.",
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
