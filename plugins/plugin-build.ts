#!/usr/bin/env bun
/**
 * Shared plugin build driver (issue #9626, TL;DR #2). The model-provider and
 * connector plugins each hand-rolled the same Bun.build + tsc-d.ts + d.ts-alias
 * algorithm with minor per-package variation (which targets, minify, whether a
 * dist clean runs, and the exact declaration-alias shims). This collapses that
 * orchestration to one place; each plugin's `build.ts` becomes a small,
 * declarative `buildPlugin({...})` call that lists only what it actually differs
 * on. The emitted `dist/` is byte-identical to the previous hand-rolled build.
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import {
  type ExternalsFromPackageJsonOptions,
  externalsFromPackageJson,
} from "./plugin-build-externals";

export interface BuildTarget {
  /** Human label for the progress log (e.g. "Node", "Browser", "Node (CJS)"). */
  label: string;
  /** Entrypoint(s) relative to the package root. */
  entry: string | string[];
  /** Output subdirectory under `dist/` (e.g. "node", "browser", "cjs"). */
  outSubdir: string;
  target: "node" | "browser" | "bun";
  format: "esm" | "cjs";
  /** Default: false. */
  minify?: boolean;
  /** Default: "external". */
  sourcemap?: "external" | "inline" | "none" | "linked";
  /** Default: false (Bun's default). */
  splitting?: boolean;
  /** Passed through to Bun.build (e.g. `{ entry: "index.node.js" }`). */
  naming?: { entry?: string; chunk?: string; asset?: string };
  /**
   * Rename emitted files after the build, e.g.
   * `[["index.node.js", "index.node.cjs"]]` or both the bundle and its map.
   */
  renames?: ReadonlyArray<readonly [from: string, to: string]>;
}

export interface DtsShim {
  /** Path relative to `dist/` to write (e.g. "index.d.ts", "node/index.d.ts"). */
  path: string;
  /** Exact file contents. */
  content: string;
}

export interface BuildPluginConfig {
  /** Package name, for log lines only. */
  name: string;
  /** Remove `dist/` before building (via the hardened rm helper). Default: true. */
  clean?: boolean;
  /** "auto" derives externals from package.json; or pass an explicit list. */
  externals?: "auto" | readonly string[];
  /** Options forwarded to externalsFromPackageJson when externals === "auto". */
  externalsOptions?: ExternalsFromPackageJsonOptions;
  targets: readonly BuildTarget[];
  /** tsconfig project passed to `tsc` for declaration emit. */
  dtsProject?: string;
  /**
   * Pass `--emitDeclarationOnly` to the declaration `tsc` invocation (for
   * plugins whose `dtsProject` tsconfig would otherwise also emit JS). Default:
   * false. */
  dtsEmitDeclarationOnly?: boolean;
  /**
   * After declaration emit, rewrite bare relative specifiers in the emitted
   * files to explicit NodeNext-resolvable paths (`./x` -> `./x.js`,
   * `./dir` -> `./dir/index.js`). Needed by single-entrypoint connector plugins
   * that ship a bundled `dist/index.js` but a per-file `.d.ts` tree whose
   * re-exports would otherwise stay bare and fail to resolve for NodeNext
   * consumers. Default: false. */
  rewriteDistImports?: boolean;
  /**
   * Tolerate a failed `tsc` declaration emit (warn + continue with JS-only
   * outputs) instead of aborting. Mirrors the per-package fallback some plugins
   * carried; default false (fail loud).
   */
  dtsTolerant?: boolean;
  /** Declaration-alias shim files to write after tsc. */
  dtsShims?: readonly DtsShim[];
  /**
   * After the JS targets build (and before declaration emit), recursively move
   * everything under `dist/<from>` up into `dist/<to ?? ".">`, then remove the
   * now-empty `dist/<from>`. Reproduces the hand-rolled "flatten `dist/src` into
   * `dist`" step used by plugins whose glob target (`naming: "[dir]/[name]"`
   * over `src/**`) emits under a `src/` prefix. Off by default; existing
   * single-/multi-target adopters that don't set it are unaffected.
   */
  flatten?: ReadonlyArray<{ from: string; to?: string }>;
  /**
   * After declaration emit (+ any `dtsShims`), copy an emitted file under
   * `dist/<from>` to `dist/<to>`. Reproduces the hand-rolled
   * `copyFileSync("dist/index.d.ts", "dist/index.d.mts")` step some plugins use
   * to publish a `.d.mts` sibling of a `tsc`-generated `.d.ts`. Unlike a
   * `dtsShim` (a frozen literal that would silently diverge from generated
   * output on any source change), this copies the real emitted file. Off by
   * default; adopters that don't set it are unaffected.
   */
  dtsCopies?: ReadonlyArray<{ from: string; to: string }>;
}

const RM_RECURSIVE = resolve(
  import.meta.dir,
  "..",
  "packages",
  "scripts",
  "rm-path-recursive.mjs",
);

const REWRITE_DIST_IMPORTS = resolve(
  import.meta.dir,
  "..",
  "packages",
  "scripts",
  "rewrite-dist-relative-imports-node-esm.mjs",
);

/**
 * Absolute path to the workspace `tsc` JS entry. Resolved via node module
 * resolution so it works regardless of the node_modules layout — a fresh CI
 * checkout, a hoisted/symlinked install, or a git worktree that borrows a
 * parent's node_modules — instead of assuming a fixed `../node_modules/...`
 * offset (which is absent in a worktree). `buildPlugin` runs it as
 * `node ${TSC_BIN}`, so it needs no `node_modules/.bin` on PATH: `Bun.$`
 * resolves commands from the bun process's startup PATH, which a bare
 * `bun test` step does not extend (only `bun run` does).
 */
const TSC_BIN = (() => {
  try {
    return createRequire(import.meta.url).resolve("typescript/bin/tsc");
  } catch {
    return resolve(
      import.meta.dir,
      "..",
      "node_modules",
      "typescript",
      "bin",
      "tsc",
    );
  }
})();

/**
 * Recursively move every file under `fromDir` into `toDir`, preserving the
 * sub-tree below `fromDir` and creating parent dirs as needed. A plain rename
 * preserves file bytes (and any inner `//# sourceMappingURL` / map `file`
 * references) exactly. The caller removes the now-empty `fromDir`.
 */
async function moveTreeContents(fromDir: string, toDir: string): Promise<void> {
  const entries = await readdir(fromDir, {
    recursive: true,
    withFileTypes: true,
  });
  for (const e of entries) {
    if (!e.isFile()) continue;
    const abs = join(e.parentPath, e.name);
    const dest = join(toDir, relative(fromDir, abs));
    await mkdir(dirname(dest), { recursive: true });
    await rename(abs, dest);
  }
}

export async function buildPlugin(config: BuildPluginConfig): Promise<void> {
  const totalStart = Date.now();
  const distDir = join(process.cwd(), "dist");

  if ((config.clean ?? true) && existsSync(distDir)) {
    await Bun.$`node ${RM_RECURSIVE} ${distDir}`;
  }
  await mkdir(distDir, { recursive: true });

  const external =
    config.externals === undefined || config.externals === "auto"
      ? await externalsFromPackageJson(
          "./package.json",
          config.externalsOptions,
        )
      : [...config.externals];

  for (const t of config.targets) {
    const start = Date.now();
    console.log(`🔨 Building ${config.name} (${t.label})…`);
    const result = await Bun.build({
      entrypoints: Array.isArray(t.entry) ? t.entry : [t.entry],
      outdir: join(distDir, t.outSubdir),
      target: t.target,
      format: t.format,
      sourcemap: t.sourcemap ?? "external",
      minify: t.minify ?? false,
      splitting: t.splitting ?? false,
      external,
      ...(t.naming ? { naming: t.naming } : {}),
    });
    if (!result.success) {
      console.error(`${t.label} build failed:`, result.logs);
      throw new Error(`${t.label} build failed`);
    }
    for (const [from, to] of t.renames ?? []) {
      try {
        await rename(
          join(distDir, t.outSubdir, from),
          join(distDir, t.outSubdir, to),
        );
      } catch (e) {
        console.warn(`${t.label} rename step warning:`, e);
      }
    }
    console.log(
      `✅ ${t.label} complete in ${((Date.now() - start) / 1000).toFixed(2)}s`,
    );
  }

  for (const f of config.flatten ?? []) {
    const fromDir = join(distDir, f.from);
    if (!existsSync(fromDir)) continue;
    const toDir = join(distDir, f.to ?? ".");
    console.log(`📂 Flattening dist/${f.from} → dist/${f.to ?? "."}…`);
    await moveTreeContents(fromDir, toDir);
    await Bun.$`node ${RM_RECURSIVE} ${fromDir}`;
  }

  if (config.dtsProject) {
    console.log("📝 Generating TypeScript declarations…");
    const project = config.dtsProject;
    const emitDeclOnly = config.dtsEmitDeclarationOnly ?? false;
    const run = emitDeclOnly
      ? () =>
          Bun.$`node ${TSC_BIN} --project ${project} --emitDeclarationOnly --noCheck`
      : () => Bun.$`node ${TSC_BIN} --project ${project} --noCheck`;
    if (config.dtsTolerant) {
      try {
        await run();
      } catch {
        console.warn(
          "Warning: TypeScript declaration generation failed; continuing with bundled JS outputs only.",
        );
      }
    } else {
      await run();
    }
  }

  for (const shim of config.dtsShims ?? []) {
    const target = join(distDir, shim.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, shim.content, "utf8");
  }

  for (const { from, to } of config.dtsCopies ?? []) {
    const dest = join(distDir, to);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(join(distDir, from), dest);
  }

  if (config.rewriteDistImports) {
    console.log("🔧 Rewriting dist relative imports for NodeNext…");
    await Bun.$`node ${REWRITE_DIST_IMPORTS}`;
  }

  console.log(
    `🎉 ${config.name} build finished in ${((Date.now() - totalStart) / 1000).toFixed(2)}s`,
  );
}
