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
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
  /** Remove `dist/` before building (via the hardened rm helper). Default: false. */
  clean?: boolean;
  /** "auto" derives externals from package.json; or pass an explicit list. */
  externals?: "auto" | readonly string[];
  /** Options forwarded to externalsFromPackageJson when externals === "auto". */
  externalsOptions?: ExternalsFromPackageJsonOptions;
  targets: readonly BuildTarget[];
  /** tsconfig project passed to `tsc` for declaration emit. */
  dtsProject?: string;
  /**
   * Tolerate a failed `tsc` declaration emit (warn + continue with JS-only
   * outputs) instead of aborting. Mirrors the per-package fallback some plugins
   * carried; default false (fail loud).
   */
  dtsTolerant?: boolean;
  /** Declaration-alias shim files to write after tsc. */
  dtsShims?: readonly DtsShim[];
}

const RM_RECURSIVE = resolve(
  import.meta.dir,
  "..",
  "packages",
  "scripts",
  "rm-path-recursive.mjs",
);

export async function buildPlugin(config: BuildPluginConfig): Promise<void> {
  const totalStart = Date.now();
  const distDir = join(process.cwd(), "dist");

  if (config.clean && existsSync(distDir)) {
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

  if (config.dtsProject) {
    console.log("📝 Generating TypeScript declarations…");
    const project = config.dtsProject;
    if (config.dtsTolerant) {
      try {
        await Bun.$`tsc --project ${project} --noCheck`;
      } catch {
        console.warn(
          "Warning: TypeScript declaration generation failed; continuing with bundled JS outputs only.",
        );
      }
    } else {
      await Bun.$`tsc --project ${project} --noCheck`;
    }
  }

  for (const shim of config.dtsShims ?? []) {
    const target = join(distDir, shim.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, shim.content, "utf8");
  }

  console.log(
    `🎉 ${config.name} build finished in ${((Date.now() - totalStart) / 1000).toFixed(2)}s`,
  );
}
