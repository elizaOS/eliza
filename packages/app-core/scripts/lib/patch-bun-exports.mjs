/**
 * Patch @elizaos packages whose exports["."].bun points to ./src/index.ts
 * (missing in published tarball). Exported for use by patch-deps.mjs and tests.
 * See docs/plugin-resolution-and-node-path.md "Bun and published package exports".
 */
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ELIZA_CORE_RUNTIME_FILES = [
  "dist/index.js",
  "dist/browser/index.browser.js",
  "dist/node/index.node.js",
];

function dedupeRealPaths(paths) {
  const seen = new Set();
  const unique = [];

  for (const candidate of paths) {
    let key = candidate;
    try {
      key = realpathSync(candidate);
    } catch {
      // Keep the original candidate if realpath resolution fails.
    }

    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }

  return unique;
}

function writeFileAtomic(filePath, contents) {
  const dir = dirname(filePath);
  const tempPath = resolve(
    dir,
    `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  writeFileSync(tempPath, contents, "utf8");
  try {
    renameSync(tempPath, filePath);
  } catch {
    // Windows can reject rename over an existing target; fall back to replace.
    rmSync(filePath, { force: true });
    renameSync(tempPath, filePath);
  }
}

/**
 * Find all package.json paths for pkgName under root (main node_modules and
 * Bun cache). Match Bun's cache dir naming: @scope/pkg → scope+pkg.
 * Exported for tests.
 */
export function findPackageJsonPaths(root, pkgName) {
  return findPackageFilePaths(root, pkgName, "package.json");
}

/**
 * Find all matching files for pkgName under root (main node_modules and Bun
 * cache). Exported so tests and other patch helpers share the same lookup.
 */
export function findPackageFilePaths(root, pkgName, relativePath) {
  const candidates = [];
  const mainPath = resolve(root, "node_modules", pkgName, relativePath);
  if (existsSync(mainPath)) candidates.push(mainPath);
  const bunCache = resolve(root, "node_modules/.bun");
  if (existsSync(bunCache)) {
    const safeNames = new Set([
      pkgName.replaceAll("/", "+"),
      pkgName.replaceAll("/", "+").replaceAll("@", ""),
    ]);
    for (const entry of readdirSync(bunCache)) {
      if (![...safeNames].some((safeName) => entry.startsWith(safeName)))
        continue;
      const p = resolve(bunCache, entry, "node_modules", pkgName, relativePath);
      if (existsSync(p)) candidates.push(p);
    }
  }
  return dedupeRealPaths(candidates);
}

function hasRequiredFiles(dirPath, relativePaths) {
  return relativePaths.every((relativePath) =>
    existsSync(resolve(dirPath, relativePath)),
  );
}

/**
 * Some published @elizaos/core builds in Bun's cache only contain dist/testing,
 * but their package.json still exports dist/node and dist/browser. Copy the
 * runtime dist from a healthy install when that happens so dependents can boot.
 */
export function repairElizaCoreRuntimeDist(targetPkgDir, sourcePkgDir) {
  if (!targetPkgDir || !sourcePkgDir) return false;
  if (targetPkgDir === sourcePkgDir) return false;
  if (!existsSync(targetPkgDir)) return false;
  if (!hasRequiredFiles(sourcePkgDir, ELIZA_CORE_RUNTIME_FILES)) return false;
  if (hasRequiredFiles(targetPkgDir, ELIZA_CORE_RUNTIME_FILES)) return false;

  const sourceDist = resolve(sourcePkgDir, "dist");
  const targetDist = resolve(targetPkgDir, "dist");

  rmSync(targetDist, { recursive: true, force: true });
  cpSync(sourceDist, targetDist, { recursive: true });
  return true;
}

/**
 * Repair any cached @elizaos/core package copies whose runtime dist files are
 * missing by cloning the dist tree from the healthy root install.
 */
export function patchBrokenElizaCoreRuntimeDists(root, log = console.log) {
  const pkgPaths = findPackageJsonPaths(root, "@elizaos/core");
  const pkgDirs = pkgPaths.map((pkgPath) => dirname(pkgPath));
  const sourcePkgDir = pkgDirs.find((pkgDir) =>
    hasRequiredFiles(pkgDir, ELIZA_CORE_RUNTIME_FILES),
  );

  if (!sourcePkgDir) {
    log(
      "[patch-deps] Skipping @elizaos/core runtime repair: no healthy source dist was found.",
    );
    return false;
  }

  let patched = false;
  for (const pkgDir of pkgDirs) {
    if (repairElizaCoreRuntimeDist(pkgDir, sourcePkgDir)) {
      patched = true;
      log(
        `[patch-deps] Repaired @elizaos/core runtime dist in Bun cache: ${pkgDir}`,
      );
    }
  }
  return patched;
}

/**
 * Install the `@elizaos/core/roles` runtime subpath.
 *
 * The published `@elizaos/core@alpha` exposes `dist/roles.d.ts` (types only)
 * and declares `export * from "./roles";` in `dist/index.node.d.ts`, but
 * neither the matching runtime `dist/roles.js` file nor a `./roles` subpath
 * in `package.json` `exports` ship in the published tarball. Every
 * `import { … } from "@elizaos/core/roles"` therefore fails with
 * `ERR_MODULE_NOT_FOUND` at runtime (vitest, node, bun) even though tsc
 * resolves the subpath via the tsconfig `paths` map to the local `./eliza`
 * source.
 *
 * Copy a pre-bundled shim (see `scripts/lib/elizaos-core-roles-shim.js`) to
 * each installed `@elizaos/core/dist/roles.js` location and add the matching
 * `./roles` entry to the package.json `exports` field. The shim bundles
 * `eliza/packages/core/src/roles.ts` verbatim with its two runtime
 * dependencies (`createUniqueUuid`, `logger`) left as top-level imports from
 * `@elizaos/core` — both of which are already present in the main published
 * runtime bundle.
 */
export function patchElizaCoreRolesSubpath(root, log = console.log) {
  const shimSource = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "elizaos-core-roles-shim.js",
  );
  if (!existsSync(shimSource)) {
    log(
      `[patch-deps] Skipping @elizaos/core/roles subpath install: shim ${shimSource} is missing`,
    );
    return false;
  }
  const shimContents = readFileSync(shimSource, "utf8");

  const pkgPaths = findPackageJsonPaths(root, "@elizaos/core");
  let patchedAny = false;

  for (const pkgPath of pkgPaths) {
    const pkgDir = dirname(pkgPath);
    const distDir = resolve(pkgDir, "dist");
    if (!existsSync(distDir)) continue;

    const targetJs = resolve(distDir, "roles.js");
    const needsJs = !existsSync(targetJs);
    let wroteJs = false;
    if (needsJs) {
      writeFileAtomic(targetJs, shimContents);
      wroteJs = true;
    }

    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
      continue;
    }
    if (!pkg || typeof pkg !== "object") continue;
    if (!pkg.exports || typeof pkg.exports !== "object") {
      pkg.exports = {};
    }

    const currentRoles = pkg.exports["./roles"];
    const needsExport =
      !currentRoles ||
      typeof currentRoles !== "object" ||
      typeof currentRoles.import !== "string" ||
      !currentRoles.import.includes("roles.js");

    let wrotePkg = false;
    if (needsExport) {
      pkg.exports["./roles"] = {
        types: "./dist/roles.d.ts",
        import: "./dist/roles.js",
        default: "./dist/roles.js",
      };
      writeFileAtomic(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
      wrotePkg = true;
    }

    if (wroteJs || wrotePkg) {
      patchedAny = true;
      log(
        `[patch-deps] Installed @elizaos/core/roles runtime subpath at ${pkgDir}`,
      );
    }
  }

  return patchedAny;
}

function findElizaPluginPackageJsonPaths(root) {
  const candidates = [];
  const rootScopeDir = resolve(root, "node_modules", "@elizaos");

  if (existsSync(rootScopeDir)) {
    for (const entry of readdirSync(rootScopeDir)) {
      if (!entry.startsWith("plugin-")) continue;
      const pkgPath = resolve(rootScopeDir, entry, "package.json");
      if (existsSync(pkgPath)) candidates.push(pkgPath);
    }
  }

  const bunCache = resolve(root, "node_modules/.bun");
  if (existsSync(bunCache)) {
    for (const entry of readdirSync(bunCache)) {
      const scopeDir = resolve(bunCache, entry, "node_modules", "@elizaos");
      if (!existsSync(scopeDir)) continue;
      for (const scopedEntry of readdirSync(scopeDir)) {
        if (!scopedEntry.startsWith("plugin-")) continue;
        const pkgPath = resolve(scopeDir, scopedEntry, "package.json");
        if (existsSync(pkgPath)) candidates.push(pkgPath);
      }
    }
  }

  return dedupeRealPaths(candidates);
}

/**
 * Bun can keep a private @elizaos/core inside individual plugin package dirs.
 * When that happens, ESM resolves the plugin's own nested core first instead of
 * the root install, which can re-introduce version skew even when the root core
 * is pinned and healthy. Remove those nested copies so plugins resolve the
 * canonical top-level core.
 */
export function pruneNestedElizaPluginCoreCopies(root, log = console.log) {
  const rootCorePkgPath = resolve(
    root,
    "node_modules",
    "@elizaos",
    "core",
    "package.json",
  );
  const preferredCorePkgPath = existsSync(rootCorePkgPath)
    ? rootCorePkgPath
    : findPackageJsonPaths(root, "@elizaos/core")[0];

  if (!preferredCorePkgPath) {
    log(
      "[patch-deps] Skipping nested @elizaos/core pruning: no root core install was found.",
    );
    return false;
  }

  let preferredCoreDir = dirname(preferredCorePkgPath);
  try {
    preferredCoreDir = realpathSync(preferredCoreDir);
  } catch {
    // Keep the unresolved dir when realpath fails.
  }

  let patched = false;
  for (const pluginPkgPath of findElizaPluginPackageJsonPaths(root)) {
    const pluginDir = dirname(pluginPkgPath);
    const nestedCoreDir = resolve(
      pluginDir,
      "node_modules",
      "@elizaos",
      "core",
    );
    if (!existsSync(nestedCoreDir)) continue;

    let resolvedNestedCoreDir = nestedCoreDir;
    try {
      resolvedNestedCoreDir = realpathSync(nestedCoreDir);
    } catch {
      // Keep the unresolved dir when realpath fails.
    }

    if (resolvedNestedCoreDir === preferredCoreDir) {
      continue;
    }

    let pluginName = pluginDir;
    try {
      const pkg = JSON.parse(readFileSync(pluginPkgPath, "utf8"));
      if (typeof pkg.name === "string" && pkg.name.trim()) {
        pluginName = pkg.name.trim();
      }
    } catch {
      // Fall back to the directory path when package.json cannot be read.
    }

    rmSync(nestedCoreDir, { recursive: true, force: true });
    patched = true;
    log(
      `[patch-deps] Removed nested @elizaos/core from ${pluginName}; plugin imports now resolve the root core.`,
    );
  }

  return patched;
}

/** @see patchElizaCoreStreamingTtsHandlerGuard */
const ELIZA_CORE_STREAMING_TTS_PATCH_MARKER =
  "getModel(ModelType.TEXT_TO_SPEECH) ? await runtime2.useModel(ModelType.TEXT_TO_SPEECH, params)";

const ELIZA_CORE_NODE_EDGE_TTS_FROM =
  "const result2 = await runtime2.useModel(ModelType.TEXT_TO_SPEECH, params);";
const ELIZA_CORE_NODE_EDGE_TTS_TO =
  "const result2 = runtime2.getModel(ModelType.TEXT_TO_SPEECH) ? await runtime2.useModel(ModelType.TEXT_TO_SPEECH, params) : void 0;";

/**
 * Minified browser bundle (variable names change between releases — extend if
 * postinstall logs "Skipping @elizaos/core streaming TTS guard" for browser).
 */
const ELIZA_CORE_BROWSER_TTS_REPLACEMENTS = [
  [
    ",S=await $.useModel(b$.TEXT_TO_SPEECH,M);",
    ",S=$.getModel(b$.TEXT_TO_SPEECH)?await $.useModel(b$.TEXT_TO_SPEECH,M):void 0;",
  ],
  [
    ",X=await $.useModel(b$.TEXT_TO_SPEECH,J);",
    ",X=$.getModel(b$.TEXT_TO_SPEECH)?await $.useModel(b$.TEXT_TO_SPEECH,J):void 0;",
  ],
];

/**
 * Eliza core's message handler synthesizes voice audio whenever `onStreamChunk`
 * is provided. Eliza's SSE chat always passes that callback, so the runtime
 * calls `useModel(TEXT_TO_SPEECH)` — unrelated to the dashboard "agent voice"
 * toggle. If no handler is registered yet (e.g. race before Edge TTS loads) or
 * no provider is configured, that throws and logs
 * "No handler found for delegate type: TEXT_TO_SPEECH".
 *
 * Guard both `useModel` sites so we only call TTS when `getModel` finds a handler.
 */
export function patchElizaCoreStreamingTtsHandlerGuard(
  root,
  log = console.log,
) {
  const pkgJsonPaths = findPackageJsonPaths(root, "@elizaos/core");
  let patchedAny = false;

  for (const pkgJsonPath of pkgJsonPaths) {
    const pkgDir = dirname(pkgJsonPath);
    const files = [
      resolve(pkgDir, "dist/node/index.node.js"),
      resolve(pkgDir, "dist/edge/index.edge.js"),
      resolve(pkgDir, "dist/browser/index.browser.js"),
    ];

    for (const filePath of files) {
      if (!existsSync(filePath)) continue;
      const src = readFileSync(filePath, "utf8");
      if (!src.includes("Error generating voice for remaining text")) continue;
      if (src.includes(ELIZA_CORE_STREAMING_TTS_PATCH_MARKER)) continue;

      let next = src;
      const isNodeOrEdge =
        filePath.endsWith("index.node.js") ||
        filePath.endsWith("index.edge.js");

      if (isNodeOrEdge) {
        if (!next.includes(ELIZA_CORE_NODE_EDGE_TTS_FROM)) continue;
        next = next.replaceAll(
          ELIZA_CORE_NODE_EDGE_TTS_FROM,
          ELIZA_CORE_NODE_EDGE_TTS_TO,
        );
      } else {
        // Newer core builds may already ship this guard in the browser bundle.
        if (
          next.includes(
            "getModel(b$.TEXT_TO_SPEECH)?await $.useModel(b$.TEXT_TO_SPEECH",
          )
        )
          continue;
        const allPresent = ELIZA_CORE_BROWSER_TTS_REPLACEMENTS.every(([from]) =>
          next.includes(from),
        );
        if (!allPresent) continue;
        for (const [from, to] of ELIZA_CORE_BROWSER_TTS_REPLACEMENTS) {
          next = next.replace(from, to);
        }
      }

      if (next !== src) {
        writeFileSync(filePath, next, "utf8");
        patchedAny = true;
        log(
          `[patch-deps] Patched @elizaos/core streaming TTS guard: ${filePath}`,
        );
      }
    }
  }

  return patchedAny;
}

/** User-visible chunk injected on each structured-output retry (non-rich stream). */
const ELIZA_CORE_STREAM_RETRY_PLACEHOLDER_NODE = `    if (!this.config.hasRichConsumer) {
      this.config.onChunk(\`
-- that's not right, let me start again:
\`);
    }
`;

/** Minified browser bundle: comma-operator if sets state then checks hasRichConsumer. */
const ELIZA_CORE_STREAM_RETRY_PLACEHOLDER_BROWSER_FROM = `if(this.state="retrying",!this.config.hasRichConsumer)this.config.onChunk(\`
-- that's not right, let me start again:
\`);`;

const ELIZA_CORE_STREAM_RETRY_PLACEHOLDER_BROWSER_TO = `this.state="retrying";`;

/**
 * Older @elizaos/core structured stream retry handling called `onChunk` with a
 * fixed apology line for non-rich streaming consumers on every parse/validation
 * retry. That duplicates in the saved message (e.g. 3× with maxRetries 3).
 * Remove the placeholder; `emitEvent({ eventType: "retry_start" })` is unchanged.
 */
export function patchElizaCoreStreamingRetryPlaceholder(
  root,
  log = console.log,
) {
  const pkgJsonPaths = findPackageJsonPaths(root, "@elizaos/core");
  let patchedAny = false;

  for (const pkgJsonPath of pkgJsonPaths) {
    const pkgDir = dirname(pkgJsonPath);
    const files = [
      resolve(pkgDir, "dist/node/index.node.js"),
      resolve(pkgDir, "dist/edge/index.edge.js"),
      resolve(pkgDir, "dist/browser/index.browser.js"),
    ];

    for (const filePath of files) {
      if (!existsSync(filePath)) continue;
      const src = readFileSync(filePath, "utf8");
      if (!src.includes("that's not right, let me start again")) continue;

      let next = src;
      if (
        filePath.endsWith("index.node.js") ||
        filePath.endsWith("index.edge.js")
      ) {
        if (!next.includes(ELIZA_CORE_STREAM_RETRY_PLACEHOLDER_NODE)) continue;
        next = next.replace(ELIZA_CORE_STREAM_RETRY_PLACEHOLDER_NODE, "");
      } else {
        if (!next.includes(ELIZA_CORE_STREAM_RETRY_PLACEHOLDER_BROWSER_FROM))
          continue;
        next = next.replaceAll(
          ELIZA_CORE_STREAM_RETRY_PLACEHOLDER_BROWSER_FROM,
          ELIZA_CORE_STREAM_RETRY_PLACEHOLDER_BROWSER_TO,
        );
      }

      if (next !== src) {
        writeFileSync(filePath, next, "utf8");
        patchedAny = true;
        log(
          `[patch-deps] Patched @elizaos/core streaming retry placeholder: ${filePath}`,
        );
      }
    }
  }

  return patchedAny;
}

/**
 * Detect stale Bun module cache and warn the user.
 *
 * Bun's content-addressable cache deduplicates packages by tarball hash. When
 * upstream publishes multiple versions with identical (stale) build artifacts,
 * they share a hash and Bun serves stale content. We can't safely remove
 * entries during postinstall (symlinks break), so we detect the condition
 * and tell the user to run `bun run repair` which does:
 *   rm -rf node_modules/.bun && bun install
 *
 * Runs once per package.json version (stamp-guarded).
 *
 * Bun cache entry format: @scope+pkg@version+contenthash
 * e.g. @elizaos+core@2.0.0-alpha.77+f9c270f5561f2899
 */
export function warnStaleBunCache(root, log = console.log) {
  const bunCacheDir = resolve(root, "node_modules/.bun");
  if (!existsSync(bunCacheDir)) return 0;

  // Only check once per package.json version.
  const pkgJsonPath = resolve(root, "package.json");
  const stampPath = resolve(bunCacheDir, ".bust-cache-stamp");
  if (existsSync(pkgJsonPath) && existsSync(stampPath)) {
    try {
      const pkgVersion =
        JSON.parse(readFileSync(pkgJsonPath, "utf8")).version || "";
      const stamp = readFileSync(stampPath, "utf8").trim();
      if (stamp === pkgVersion) return 0;
    } catch {}
  }

  const prefixes = [
    "@elizaos+core@",
    "@elizaos+autonomous@",
    "@elizaos+app-core@",
    "@elizaos+prompts@",
    "@elizaos+skills@",
  ];
  let staleCount = 0;

  let allEntries;
  try {
    allEntries = readdirSync(bunCacheDir);
  } catch (err) {
    log(`[patch-deps] Warning: failed to read Bun cache: ${err.message}`);
    return 0;
  }

  for (const prefix of prefixes) {
    const entries = allEntries.filter((e) => e.startsWith(prefix));
    if (entries.length < 2) continue;

    // Group by content hash (the part after the last '+')
    const byHash = new Map();
    for (const entry of entries) {
      const plusIdx = entry.lastIndexOf("+");
      if (plusIdx === -1 || plusIdx === entry.length - 1) continue;
      const hash = entry.slice(plusIdx + 1);
      if (!byHash.has(hash)) byHash.set(hash, []);
      byHash.get(hash).push(entry);
    }

    for (const [, group] of byHash) {
      if (group.length >= 2) staleCount += group.length - 1;
    }
  }

  // Write stamp regardless so we don't re-check every install.
  try {
    const pkgVersion = existsSync(pkgJsonPath)
      ? JSON.parse(readFileSync(pkgJsonPath, "utf8")).version || ""
      : "";
    writeFileSync(stampPath, pkgVersion, "utf8");
  } catch {}

  if (staleCount > 0) {
    log(
      `[patch-deps] ⚠️  Detected ${staleCount} stale Bun cache entries. Run: rm -rf node_modules/.bun && bun install`,
    );
  }
  return staleCount;
}

/**
 * If pkg.json has exports["."].bun = "./src/index.ts" and that file doesn't
 * exist, remove "bun" and "default" so resolver uses "import" → dist/.
 * Returns true if the file was patched.
 */
export function applyPatchToPackageJson(pkgPath) {
  if (!existsSync(pkgPath)) return false;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const dot = pkg.exports?.["."];
  if (!dot || typeof dot !== "object") return false;
  if (!dot.bun?.endsWith("/src/index.ts")) return false;

  const dir = dirname(pkgPath);
  if (existsSync(resolve(dir, dot.bun))) return false; // src exists — no patch

  delete dot.bun;
  if (dot.default?.endsWith("/src/index.ts")) {
    delete dot.default;
  }
  writeFileAtomic(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  return true;
}

/**
 * Some published packages only export subpaths with explicit `.js` suffixes
 * (for example "./sha3.js"), while runtime consumers import the extensionless
 * variant ("@scope/pkg/sha3"). Add extensionless aliases so Bun resolves the
 * published package the same way as modern bundlers.
 */
export function applyExtensionlessJsExportAliases(pkgPath) {
  if (!existsSync(pkgPath)) return false;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const exportsField = pkg.exports;
  if (
    !exportsField ||
    typeof exportsField !== "object" ||
    Array.isArray(exportsField)
  ) {
    return false;
  }

  let patched = false;
  for (const [key, value] of Object.entries(exportsField)) {
    if (!key.startsWith("./") || !key.endsWith(".js")) continue;
    const alias = key.slice(0, -3);
    if (Object.hasOwn(exportsField, alias)) continue;
    exportsField[alias] = value;
    patched = true;
  }

  if (!patched) return false;

  writeFileAtomic(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  return true;
}

/**
 * Some upstream @elizaos packages (notably @elizaos/agent and @elizaos/ui)
 * publish exports maps where glob subpath targets still carry the source
 * extension before the .js / .d.ts suffix — e.g. "./packages/agent/src/runtime/*.ts.js".
 * That breaks Bun resolution because the on-disk files are "*.js" / "*.d.ts".
 *
 * The bug originates in eliza's prepare-package-dist.mjs `replaceSourceExtension`
 * helper (it appends ".js" instead of replacing the source extension when the
 * relative path contains a "*"). Rather than wait for upstream republish, we
 * rewrite every export value matching /\*\.(ts|tsx|mts|cts)\.(js|d\.ts)$/
 * back to its correct dist form.
 */
function rewriteTsTsxJsGlobValue(value) {
  if (typeof value !== "string") return { value, changed: false };
  // Replace `*.ts.js` / `*.tsx.js` / `*.mts.js` / `*.cts.js` → `*.js`
  // and `*.ts.d.ts` / `*.tsx.d.ts` etc. → `*.d.ts`.
  const next = value
    .replace(/\*\.(?:ts|tsx|mts|cts)\.js$/, "*.js")
    .replace(/\*\.(?:ts|tsx|mts|cts)\.d\.ts$/, "*.d.ts");
  return { value: next, changed: next !== value };
}

function rewriteTsTsxJsGlobConditions(node) {
  if (typeof node === "string") {
    return rewriteTsTsxJsGlobValue(node);
  }
  if (Array.isArray(node)) {
    let changed = false;
    const next = node.map((entry) => {
      const result = rewriteTsTsxJsGlobConditions(entry);
      if (result.changed) changed = true;
      return result.value;
    });
    return { value: next, changed };
  }
  if (node && typeof node === "object") {
    let changed = false;
    const next = {};
    for (const [k, v] of Object.entries(node)) {
      const result = rewriteTsTsxJsGlobConditions(v);
      if (result.changed) changed = true;
      next[k] = result.value;
    }
    return { value: next, changed };
  }
  return { value: node, changed: false };
}

export function applyTsTsxJsGlobFix(pkgPath) {
  if (!existsSync(pkgPath)) return false;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const exportsField = pkg.exports;
  if (
    !exportsField ||
    typeof exportsField !== "object" ||
    Array.isArray(exportsField)
  ) {
    return false;
  }

  let patched = false;
  for (const [key, value] of Object.entries(exportsField)) {
    const result = rewriteTsTsxJsGlobConditions(value);
    if (result.changed) {
      exportsField[key] = result.value;
      patched = true;
    }
  }

  if (!patched) return false;

  writeFileAtomic(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  return true;
}

/**
 * @noble/hashes@2.x removed several legacy direct entry points that ethers@6
 * still imports (sha256, sha512, ripemd160). Recreate those shims so Bun can
 * resolve the package without downgrading the whole tree.
 */
export function applyNobleHashesCompat(pkgPath) {
  if (!existsSync(pkgPath)) return false;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (pkg.name !== "@noble/hashes") return false;

  const exportsField = pkg.exports;
  if (
    !exportsField ||
    typeof exportsField !== "object" ||
    Array.isArray(exportsField)
  ) {
    return false;
  }

  const dir = dirname(pkgPath);
  const shims = [
    {
      subpath: "_assert",
      sourceFile: "utils.js",
      contents: [
        'import { isBytes, abytes, anumber, ahash, aexists, aoutput } from "./utils.js";',
        "export { isBytes, abytes, anumber, ahash, aexists, aoutput };",
        "export const number = anumber;",
        "export function bool(value) {",
        '  if (typeof value !== "boolean") throw new TypeError(`boolean expected, got ${value}`);',
        "}",
        "export function bytes(value, ...lengths) {",
        "  abytes(value);",
        "  if (lengths.length > 0 && !lengths.includes(value.length)) {",
        "    throw new RangeError(`Uint8Array expected of length ${lengths}, got length=${value.length}`);",
        "  }",
        "}",
        "export const hash = ahash;",
        "export const exists = aexists;",
        "export const output = aoutput;",
        "export default { number, bool, bytes, hash, exists, output };",
        "",
      ].join("\n"),
    },
    {
      subpath: "ripemd160",
      sourceFile: "legacy.js",
      contents: 'export { ripemd160 } from "./legacy.js";\n',
    },
    {
      subpath: "sha256",
      sourceFile: "sha2.js",
      contents: 'export { sha256 } from "./sha2.js";\n',
    },
    {
      subpath: "sha512",
      sourceFile: "sha2.js",
      contents: 'export { sha512 } from "./sha2.js";\n',
    },
  ];

  let patched = false;

  for (const shim of shims) {
    if (!existsSync(resolve(dir, shim.sourceFile))) continue;

    const exportKey = `./${shim.subpath}`;
    const exportFileKey = `./${shim.subpath}.js`;
    const exportTarget = `./${shim.subpath}.js`;
    const shimPath = resolve(dir, `${shim.subpath}.js`);

    if (!existsSync(shimPath)) {
      writeFileSync(shimPath, shim.contents, "utf8");
      patched = true;
    }

    if (exportsField[exportKey] !== exportTarget) {
      exportsField[exportKey] = exportTarget;
      patched = true;
    }

    if (exportsField[exportFileKey] !== exportTarget) {
      exportsField[exportFileKey] = exportTarget;
      patched = true;
    }
  }

  if (!patched) return false;

  writeFileAtomic(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  return true;
}

/**
 * Remove a lifecycle script when it references a file that is missing from the
 * published package tarball. This is used for upstream packages that ship a
 * broken postinstall hook.
 */
export function applyMissingLifecycleScriptPatch(
  pkgPath,
  scriptName,
  relativeTarget,
) {
  if (!existsSync(pkgPath)) return false;

  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const lifecycleScripts = pkg.scripts;
  const lifecycleCommand = lifecycleScripts?.[scriptName];
  if (
    !lifecycleScripts ||
    typeof lifecycleCommand !== "string" ||
    !lifecycleCommand.includes(relativeTarget)
  ) {
    return false;
  }

  const dir = dirname(pkgPath);
  if (existsSync(resolve(dir, relativeTarget))) {
    return false;
  }

  delete lifecycleScripts[scriptName];
  if (Object.keys(lifecycleScripts).length === 0) {
    delete pkg.scripts;
  }

  writeFileAtomic(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  return true;
}

/**
 * Patch all copies of pkgName under root (node_modules and Bun cache).
 * Logs when a file is patched. Used by postinstall in patch-deps.mjs.
 */
export function patchBunExports(root, pkgName, log = console.log) {
  const candidates = findPackageJsonPaths(root, pkgName);
  let patched = false;
  for (const pkgPath of candidates) {
    if (applyPatchToPackageJson(pkgPath)) {
      patched = true;
      log(
        `[patch-deps] Patched ${pkgName} exports: removed dead "bun"/"default" → src/index.ts conditions.`,
      );
    }
  }
  return patched;
}

/**
 * Patch all copies of pkgName so any "./foo.js" export also exposes "./foo".
 */
export function patchExtensionlessJsExports(root, pkgName, log = console.log) {
  const candidates = findPackageJsonPaths(root, pkgName);
  let patched = false;
  for (const pkgPath of candidates) {
    if (applyExtensionlessJsExportAliases(pkgPath)) {
      patched = true;
      log(
        `[patch-deps] Patched ${pkgName} exports: added extensionless aliases for .js subpaths.`,
      );
    }
  }
  return patched;
}

/**
 * Patch all copies of pkgName so any glob export target carrying a stray source
 * extension before .js/.d.ts is rewritten to the actual emitted dist path.
 * Workaround for the upstream prepare-package-dist.mjs glob bug.
 */
export function patchTsTsxJsGlobs(root, pkgName, log = console.log) {
  const candidates = findPackageJsonPaths(root, pkgName);
  let patched = false;
  for (const pkgPath of candidates) {
    if (applyTsTsxJsGlobFix(pkgPath)) {
      patched = true;
      log(
        `[patch-deps] Patched ${pkgName} exports: rewrote *.ts.js / *.ts.d.ts glob targets to *.js / *.d.ts.`,
      );
    }
  }
  return patched;
}

/**
 * Patch all copies of @noble/hashes so legacy ethers subpaths keep resolving
 * even when Bun installs the newer 2.x package at the root.
 */
export function patchNobleHashesCompat(root, log = console.log) {
  const candidates = findPackageJsonPaths(root, "@noble/hashes");
  let patched = false;
  for (const pkgPath of candidates) {
    if (applyNobleHashesCompat(pkgPath)) {
      patched = true;
      log(
        "[patch-deps] Patched @noble/hashes exports: restored legacy ethers-compatible sha256/sha512/ripemd160 shims.",
      );
    }
  }
  return patched;
}

/**
 * Patch all copies of pkgName so a broken lifecycle hook is removed when the
 * referenced script file is missing from the installed package.
 */
export function patchMissingLifecycleScript(
  root,
  pkgName,
  scriptName,
  relativeTarget,
  log = console.log,
) {
  const candidates = findPackageJsonPaths(root, pkgName);
  let patched = false;
  for (const pkgPath of candidates) {
    if (applyMissingLifecycleScriptPatch(pkgPath, scriptName, relativeTarget)) {
      patched = true;
      log(
        `[patch-deps] Patched ${pkgName} ${scriptName}: removed lifecycle hook referencing missing ${relativeTarget}.`,
      );
    }
  }
  return patched;
}

function loadElizaOnboardingPresetsSource(root, targetPath) {
  const sourcePath = resolve(
    root,
    "eliza/packages/app-core/src/onboarding-presets.ts",
  );
  const source = readFileSync(sourcePath, "utf8");
  if (!targetPath?.endsWith(".js")) {
    return source;
  }

  return ts.transpileModule(source, {
    fileName: sourcePath,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
}

/**
 * Eliza owns the onboarding preset roster, but the published autonomous
 * package still serves upstream style presets. Replace the installed module
 * with Eliza's local preset source so the onboarding API and runtime expose
 * the same Eliza-specific characters that app-core is patched to display.
 */
export function applyAutonomousElizaOnboardingPresetsPatch(filePath, source) {
  if (!existsSync(filePath)) return false;

  // When writing to a .js file, strip TypeScript-only syntax so Bun can
  // parse it as plain JavaScript. The source is always loaded from the
  // local .ts file which may contain `as const`, type annotations, etc.
  let output = source;
  if (filePath.endsWith(".js")) {
    output = stripTypeScriptSyntax(output);
  }

  const compatSource = readFileSync(filePath, "utf8");
  if (compatSource === output) return false;

  writeFileSync(filePath, output, "utf8");
  return true;
}

/**
 * Naively strip TypeScript-only syntax from a source string so it can be
 * loaded as plain JavaScript by Bun. Handles the patterns used in
 * onboarding-presets.ts:
 *   - `] as const;`  →  `];`
 *   - `export const FOO: Type<...> = {`  →  `export const FOO = {`
 *   - Interface-style property lines inside a Record<> type block
 */
function stripTypeScriptSyntax(src) {
  // Remove `as const` assertions
  src = src.replace(/\]\s+as\s+const\s*;/g, "];");

  // Remove inline type annotations on const declarations:
  //   export const FOO: Record<\n  string,\n  {\n    ...\n  }\n> = {
  // Matches `: <type>` between the variable name and ` = `.
  src = src.replace(
    /^(export\s+const\s+\w+)\s*:\s*Record<[\s\S]*?>\s*=/gm,
    "$1 =",
  );

  return src;
}

export function patchAutonomousElizaOnboardingPresets(
  root,
  log = console.log,
  source,
) {
  const candidates = [
    ...findPackageFilePaths(
      root,
      "@elizaos/agent",
      "eliza/agent/src/onboarding-presets.js",
    ),
    ...findPackageFilePaths(
      root,
      "@elizaos/agent",
      "src/onboarding-presets.js",
    ),
    ...findPackageFilePaths(
      root,
      "@elizaos/agent",
      "src/onboarding-presets.ts",
    ),
  ];

  let patched = false;
  for (const filePath of candidates) {
    const nextSource =
      source ?? loadElizaOnboardingPresetsSource(root, filePath);
    if (!applyAutonomousElizaOnboardingPresetsPatch(filePath, nextSource)) {
      continue;
    }
    patched = true;
    log(
      "[patch-deps] Patched @elizaos/agent eliza/agent/src/onboarding-presets.js: onboarding presets now derive from Eliza.",
    );
  }

  return patched;
}

/**
 * @elizaos/plugin-vision currently defaults to CAMERA mode and keeps retrying
 * imagesnap/fswebcam/ffmpeg when OS camera permission is denied. In the
 * desktop app this spams logs and can interfere with startup. Patch the
 * published bundle so camera capture defaults to OFF and a permission denial
 * disables the camera loop until the user explicitly re-enables it.
 */
export function applyPluginVisionPermissionPatch(filePath) {
  if (!existsSync(filePath)) return false;

  let source = readFileSync(filePath, "utf8");
  if (
    source.includes(
      "Camera permission not granted; disabling camera capture until permission is granted.",
    )
  ) {
    return false;
  }

  const replacements = [
    [
      '    visionMode: "CAMERA" /* CAMERA */,',
      '    visionMode: "OFF" /* OFF */,',
    ],
    [
      "  camera = null;\n  lastFrame = null;",
      "  camera = null;\n  cameraPermissionDenied = false;\n  lastFrame = null;",
    ],
    [
      "  async initializeCameraVision() {\n    const toolCheck = await this.checkCameraTools();",
      "  async initializeCameraVision() {\n    this.cameraPermissionDenied = false;\n    const toolCheck = await this.checkCameraTools();",
    ],
    [
      "  startFrameProcessing() {\n    if (this.frameProcessingInterval) {\n      return;\n    }",
      "  startFrameProcessing() {\n    if (this.frameProcessingInterval || this.cameraPermissionDenied) {\n      return;\n    }",
    ],
    [
      "      if (!this.isProcessing && this.camera) {",
      "      if (!this.isProcessing && this.camera && !this.cameraPermissionDenied) {",
    ],
    [
      "    if (!this.camera) {\n      return;\n    }",
      "    if (!this.camera || this.cameraPermissionDenied) {\n      return;\n    }",
    ],
    [
      `    } catch (error) {
      logger14.error("[VisionService] Error capturing frame:", error);
    }`,
      `    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (/camera access not granted|permission denied|not authorized|not permitted|device access denied/i.test(errorMessage)) {
        if (!this.cameraPermissionDenied) {
          logger14.warn("[VisionService] Camera permission not granted; disabling camera capture until permission is granted.");
        }
        this.cameraPermissionDenied = true;
        this.camera = null;
        if (this.frameProcessingInterval) {
          clearInterval(this.frameProcessingInterval);
          this.frameProcessingInterval = null;
        }
        if (this.visionConfig.visionMode === "BOTH" /* BOTH */) {
          this.visionConfig.visionMode = "SCREEN" /* SCREEN */;
        } else if (this.visionConfig.visionMode === "CAMERA" /* CAMERA */) {
          this.visionConfig.visionMode = "OFF" /* OFF */;
        }
        return;
      }
      logger14.error("[VisionService] Error capturing frame:", error);
    }`,
    ],
    [
      `    } catch (error) {
      logger14.error("[VisionService] Failed to capture image:", error);
      return null;
    }`,
      `    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (/camera access not granted|permission denied|not authorized|not permitted|device access denied/i.test(errorMessage)) {
        logger14.warn("[VisionService] Camera permission not granted; skipping image capture.");
        this.cameraPermissionDenied = true;
        this.camera = null;
        return null;
      }
      logger14.error("[VisionService] Failed to capture image:", error);
      return null;
    }`,
    ],
  ];

  for (const [searchValue, replaceValue] of replacements) {
    if (!source.includes(searchValue)) return false;
    source = source.replace(searchValue, replaceValue);
  }

  writeFileSync(filePath, source, "utf8");
  return true;
}

export function patchPluginVisionPermissionHandling(root, log = console.log) {
  const candidates = findPackageFilePaths(
    root,
    "@elizaos/plugin-vision",
    "dist/index.js",
  );

  let patched = false;
  for (const filePath of candidates) {
    if (!applyPluginVisionPermissionPatch(filePath)) continue;
    patched = true;
    log(
      `[patch-deps] Patched @elizaos/plugin-vision camera permission handling: ${filePath}`,
    );
  }

  return patched;
}

/**
 * proper-lockfile expects require("signal-exit") to return a callable export
 * (v3 behavior). In v4 the package exports an object with { onExit }. Patch the
 * require site so the dependency works with either version.
 */
export function applyProperLockfileSignalExitCompat(filePath) {
  if (!existsSync(filePath)) return false;

  const compatSource = readFileSync(filePath, "utf8");
  const patchedLine =
    "const signalExit = require('signal-exit');\nconst onExit = typeof signalExit === 'function' ? signalExit : signalExit.onExit;";
  if (compatSource.includes(patchedLine)) return false;

  const originalLine = "const onExit = require('signal-exit');";
  if (!compatSource.includes(originalLine)) return false;

  writeFileSync(
    filePath,
    compatSource.replace(originalLine, patchedLine),
    "utf8",
  );
  return true;
}

/**
 * Patch all copies of proper-lockfile so signal-exit v3/v4 both work.
 */
export function patchProperLockfileSignalExitCompat(root, log = console.log) {
  const candidates = findPackageFilePaths(
    root,
    "proper-lockfile",
    "lib/lockfile.js",
  );
  let patched = false;
  for (const filePath of candidates) {
    if (applyProperLockfileSignalExitCompat(filePath)) {
      patched = true;
      log(
        "[patch-deps] Patched proper-lockfile: signal-exit v3/v4 compatibility applied.",
      );
    }
  }
  return patched;
}

const PTY_MANAGER_CURSOR_POSITION_WRITE =
  '      this.ptyProcess.write("\\x1B[1;1R");';
const PTY_MANAGER_ESM_CREATE_REQUIRE_MARKER =
  "const __require = createRequire(import.meta.url);";
const PTY_MANAGER_ESM_DIRNAME_MARKER =
  "const __dirname = dirname(fileURLToPath(import.meta.url));";
const CODEX_TRUST_PROMPT_PATTERN_FROM =
  "do.?you.?trust.?the.?contents|trust.?this.?directory|yes,?.?continue|prompt.?injection";
const CODEX_TRUST_PROMPT_PATTERN_TO =
  "do.?you.?trust.?the.?contents|trust.?this.?directory|allow.?codex.?to.?work.?in.?this.?folder|without.?asking.?for.?approval|yes,?.?continue|prompt.?injection";
const CODEX_BLOCKING_PROMPT_CONDITION_FROM =
  "/would.?you.?like.?to.?run.?the.?following.?command/i.test(stripped) || /do.?you.?want.?to.?approve.?access/i.test(stripped) || /would.?you.?like.?to.?make.?the.?following.?edits/i.test(stripped) || /press.?enter.?to.?confirm/i.test(stripped) && /esc.?to.?cancel/i.test(stripped)";
const CODEX_BLOCKING_PROMPT_CONDITION_TO =
  "/would.?you.?like.?to.?run.?the.?following.?command/i.test(stripped) || /do.?you.?want.?to.?approve.?access/i.test(stripped) || /would.?you.?like.?to.?make.?the.?following.?edits/i.test(stripped) || /allow.?codex.?to.?work.?in.?this.?folder/i.test(stripped) || /without.?asking.?for.?approval/i.test(stripped) || /press.?enter.?to.?confirm/i.test(stripped) && /esc.?to.?cancel/i.test(stripped)";
const PTY_MANAGER_ESM_REQUIRE_PROLOGUE = `var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
`;

/**
 * pty-manager's published ESM bundle references __dirname but never defines it.
 * That only blows up once Node executes spawn-time code paths, so patch it
 * proactively to preserve Node + Bun parity.
 */
export function applyPtyManagerEsmDirnameCompat(filePath) {
  if (!existsSync(filePath)) return false;

  const compatSource = readFileSync(filePath, "utf8");
  if (
    compatSource.includes(PTY_MANAGER_ESM_DIRNAME_MARKER) &&
    compatSource.includes(PTY_MANAGER_ESM_CREATE_REQUIRE_MARKER)
  ) {
    return false;
  }

  const pathImportPattern =
    /import\s+\{[^}]*\bdirname\b[^}]*\}\s+from\s+"path";/;
  const moduleImport = 'import { createRequire } from "module";';
  const childProcessImportPattern =
    /import\s+\{[^}]*\bexecSync\b[^}]*\}\s+from\s+"child_process";/;
  if (
    !pathImportPattern.test(compatSource) ||
    !childProcessImportPattern.test(compatSource)
  ) {
    return false;
  }

  let next = compatSource;
  if (next.includes(PTY_MANAGER_ESM_REQUIRE_PROLOGUE)) {
    next = next.replace(
      PTY_MANAGER_ESM_REQUIRE_PROLOGUE,
      `${moduleImport}\n${PTY_MANAGER_ESM_CREATE_REQUIRE_MARKER}\n`,
    );
  } else if (!next.includes(PTY_MANAGER_ESM_CREATE_REQUIRE_MARKER)) {
    next = `${moduleImport}\n${PTY_MANAGER_ESM_CREATE_REQUIRE_MARKER}\n${next}`;
  }
  if (!next.includes('import { fileURLToPath } from "url";')) {
    next = next.replace(
      pathImportPattern,
      (match) => `${match}\nimport { fileURLToPath } from "url";`,
    );
  }
  if (!next.includes(PTY_MANAGER_ESM_DIRNAME_MARKER)) {
    next = next.replace(
      childProcessImportPattern,
      (match) => `${match}\n${PTY_MANAGER_ESM_DIRNAME_MARKER}`,
    );
  }

  if (next === compatSource) return false;

  writeFileSync(filePath, next, "utf8");
  return true;
}

/**
 * Patch all installed pty-manager ESM bundles so Node can execute spawn-time
 * code paths without crashing on an undefined __dirname reference.
 */
export function patchPtyManagerEsmDirnameCompat(root, log = console.log) {
  const searchRoots = dedupeRealPaths(
    [root, resolve(root, "eliza")].filter((candidate) => existsSync(candidate)),
  );
  const candidates = dedupeRealPaths(
    searchRoots.flatMap((searchRoot) =>
      findPackageFilePaths(searchRoot, "pty-manager", "dist/index.mjs"),
    ),
  );
  let patched = false;
  for (const filePath of candidates) {
    if (applyPtyManagerEsmDirnameCompat(filePath)) {
      patched = true;
      log(
        `[patch-deps] Patched pty-manager ESM __dirname compatibility: ${filePath}`,
      );
    }
  }
  return patched;
}

/**
 * Codex asks the terminal emulator for cursor position via ESC[6n during TUI
 * bootstrap. node-pty exposes a PTY, not a terminal emulator, so nothing
 * answers unless we synthesize a CPR response on the host side.
 */
export function applyPtyManagerCursorPositionCompat(filePath) {
  if (!existsSync(filePath)) return false;

  const compatSource = readFileSync(filePath, "utf8");
  if (compatSource.includes(PTY_MANAGER_CURSOR_POSITION_WRITE)) return false;

  const outputBufferLine = "      this.outputBuffer += data;";
  const emitOutputLine = '      this.emit("output", data);';
  const scheduleGuard = "      if (!this._processScheduled) {";
  const processOutputDoc =
    "  /**\n   * Process the accumulated output buffer.\n";

  if (
    !compatSource.includes(outputBufferLine) ||
    !compatSource.includes(emitOutputLine) ||
    !compatSource.includes(scheduleGuard) ||
    !compatSource.includes(processOutputDoc)
  ) {
    return false;
  }

  let next = compatSource.replace(
    outputBufferLine,
    "      const sanitizedData = this.respondToCursorPositionRequests(data);\n      this.outputBuffer += sanitizedData;",
  );
  next = next.replace(
    emitOutputLine,
    '      if (sanitizedData.length > 0) {\n        this.emit("output", sanitizedData);\n      }',
  );
  next = next.replace(
    scheduleGuard,
    "      if (sanitizedData.length > 0 && !this._processScheduled) {",
  );
  next = next.replace(
    processOutputDoc,
    [
      "  respondToCursorPositionRequests(data) {",
      '    if (!this.ptyProcess || !data.includes("\\x1B[6n")) {',
      "      return data;",
      "    }",
      "    let requestCount = 0;",
      "    const sanitizedData = data.replace(/\\x1B\\[6n/g, () => {",
      "      requestCount += 1;",
      '      return "";',
      "    });",
      "    for (let i = 0; i < requestCount; i += 1) {",
      PTY_MANAGER_CURSOR_POSITION_WRITE,
      "    }",
      "    if (requestCount > 0) {",
      "      this.logger.debug(",
      "        { sessionId: this.id, requestCount },",
      '        "Responded to cursor position request",',
      "      );",
      "    }",
      "    return sanitizedData;",
      "  }",
      "",
      processOutputDoc.trimEnd(),
    ].join("\n"),
  );

  if (next === compatSource) return false;

  writeFileSync(filePath, next, "utf8");
  return true;
}

/**
 * Patch all installed pty-manager copies so CPR requests get terminal-style
 * responses when coding-agent CLIs run under node-pty.
 */
export function patchPtyManagerCursorPositionCompat(root, log = console.log) {
  const searchRoots = dedupeRealPaths(
    [root, resolve(root, "eliza")].filter((candidate) => existsSync(candidate)),
  );
  const candidates = dedupeRealPaths(
    searchRoots.flatMap((searchRoot) => [
      ...findPackageFilePaths(searchRoot, "pty-manager", "dist/index.js"),
      ...findPackageFilePaths(searchRoot, "pty-manager", "dist/index.mjs"),
      ...findPackageFilePaths(searchRoot, "pty-manager", "dist/pty-worker.js"),
    ]),
  );
  let patched = false;
  for (const filePath of candidates) {
    if (applyPtyManagerCursorPositionCompat(filePath)) {
      patched = true;
      log(
        `[patch-deps] Patched pty-manager cursor position compatibility: ${filePath}`,
      );
    }
  }
  return patched;
}

/**
 * Codex added a repo trust prompt that offers "allow Codex to work in this
 * folder without asking for approval". Older adapter builds only recognize the
 * legacy trust-directory copy, so sessions block before the initial task runs.
 */
export function applyCodexFolderApprovalPromptCompat(filePath) {
  if (!existsSync(filePath)) return false;

  const compatSource = readFileSync(filePath, "utf8");
  if (compatSource.includes("allow.?codex.?to.?work.?in.?this.?folder")) {
    return false;
  }
  if (
    !compatSource.includes(CODEX_TRUST_PROMPT_PATTERN_FROM) ||
    !compatSource.includes(CODEX_BLOCKING_PROMPT_CONDITION_FROM)
  ) {
    return false;
  }

  const next = compatSource
    .replace(CODEX_TRUST_PROMPT_PATTERN_FROM, CODEX_TRUST_PROMPT_PATTERN_TO)
    .replace(
      CODEX_BLOCKING_PROMPT_CONDITION_FROM,
      CODEX_BLOCKING_PROMPT_CONDITION_TO,
    );

  if (next === compatSource) return false;

  writeFileSync(filePath, next, "utf8");
  return true;
}

/**
 * Patch installed coding-agent-adapters bundles so Codex auto-accepts the
 * current repo trust prompt in PTY-driven sessions.
 */
export function patchCodexFolderApprovalPromptCompat(root, log = console.log) {
  const candidates = [
    ...findPackageFilePaths(root, "coding-agent-adapters", "dist/index.js"),
    ...findPackageFilePaths(root, "coding-agent-adapters", "dist/index.cjs"),
  ];
  let patched = false;
  for (const filePath of candidates) {
    if (applyCodexFolderApprovalPromptCompat(filePath)) {
      patched = true;
      log(
        `[patch-deps] Patched coding-agent-adapters Codex approval prompt compatibility: ${filePath}`,
      );
    }
  }
  return patched;
}

/**
 * Electrobun's CLI download script passes Windows backslash paths to `tar -xzf`.
 * GNU tar (Git Bash / MSYS2) interprets `A:\...` as a remote host prefix, so
 * extraction fails. Replace the absolute tarballPath with a relative filename
 * since cwd is already the cache directory.
 *
 * findPackageFilePaths covers both root node_modules/ and Bun's hoisted
 * .bun/electrobun@* / cache. The workspace-aware createRequire resolution in
 * build-patched-electrobun-cli.mjs resolves from a specific workspace, but here
 * we want to patch every copy found — the simpler lookup is appropriate.
 */
export function patchElectrobunWindowsTar(root, log = console.log) {
  const tarballPathPlaceholder = "$" + "{tarballPath}";
  const platformPlaceholder = "$" + "{platform}";
  const archPlaceholder = "$" + "{arch}";
  const candidates = findPackageFilePaths(
    root,
    "electrobun",
    "bin/electrobun.cjs",
  );
  let patched = false;
  const needle = `execSync(\`tar -xzf "${tarballPathPlaceholder}"\`, { cwd: cacheDir, stdio: 'pipe' });`;
  const replacement = `execSync(\`tar -xzf electrobun-${platformPlaceholder}-${archPlaceholder}.tar.gz\`, { cwd: cacheDir, stdio: 'pipe' });`;
  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;
    const source = readFileSync(filePath, "utf8");
    if (!source.includes(needle)) continue;
    writeFileSync(filePath, source.replace(needle, replacement), "utf8");
    patched = true;
    log(
      "[patch-deps] Patched electrobun: tar extraction uses forward slashes on Windows.",
    );
  }
  return patched;
}

export function patchAutonomousTypeError(root, log = console.log) {
  const candidates = findPackageFilePaths(
    root,
    "@elizaos/agent",
    "src/api/server.ts",
  );
  let patched = false;
  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;
    let source = readFileSync(filePath, "utf8");
    // Skip if already fixed by widening through the generated API surface.
    if (
      source.includes(
        "as Partial<SubscriptionAuthApi> as SubscriptionAuthApi",
      )
    )
      continue;
    if (source.includes("as SubscriptionAuthApi")) {
      source = source.replaceAll(
        "as SubscriptionAuthApi",
        "as Partial<SubscriptionAuthApi> as SubscriptionAuthApi",
      );
      writeFileSync(filePath, source, "utf8");
      patched = true;
      log("[patch-deps] Patched @elizaos/agent type error in server.ts");
    }
  }
  return patched;
}
