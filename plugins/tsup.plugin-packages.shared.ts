/**
 * Shared tsup configuration for workspace plugin packages that emit unbundled ESM.
 *
 * The build discovers source entries, rewrites relative TypeScript import
 * specifiers to runtime `.js` paths, and cleans the package `dist/` directory
 * once before esbuild writes per-file output.
 */

import { existsSync, promises as fsp, readdirSync, rmSync } from "node:fs";
import path from "node:path";

type EsbuildOnLoadArgs = {
  path: string;
};

type EsbuildOnLoadResult = {
  contents: string;
  loader: "ts" | "tsx";
};

type EsbuildPluginBuild = {
  onLoad(
    options: { filter: RegExp },
    callback: (args: EsbuildOnLoadArgs) => Promise<EsbuildOnLoadResult>,
  ): void;
};

function resolvePackageRoot(): string {
  // CWD wins when it points at a real package directory. A parent
  // process's `npm_package_json` env leaks into spawned children
  // (e.g. setup-upstreams runs `bun run build` from the eliza root with
  // `cwd: <plugin>`), which would otherwise send us walking the wrong
  // package's `src/`. Trust cwd's package.json before the env hint.
  const cwd = process.cwd();
  if (existsSync(path.join(cwd, "package.json"))) {
    return cwd;
  }
  if (typeof process.env.npm_package_json === "string") {
    return path.dirname(process.env.npm_package_json);
  }
  return cwd;
}

function collectSrcEntries(srcRoot: string): string[] {
  if (!existsSync(srcRoot)) {
    return [];
  }

  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "__tests__") continue;
        walk(full);
      } else if (/\.(ts|tsx)$/.test(ent.name)) {
        if (
          /\.d\.ts$/.test(ent.name) ||
          /\.test\.(ts|tsx)$/.test(ent.name) ||
          /\.spec\.(ts|tsx)$/.test(ent.name)
        ) {
          continue;
        }
        out.push(
          path.relative(resolvePackageRoot(), full).split(path.sep).join("/"),
        );
      }
    }
  };
  walk(srcRoot);
  if (out.length === 0) {
    throw new Error(
      `[tsup.plugin-packages.shared] No entries under ${srcRoot}`,
    );
  }
  return out;
}

function resolveRelativeRuntimeSpecifier(
  importerPath: string,
  specifier: string,
): string {
  if (!specifier.startsWith(".")) {
    return specifier;
  }
  if (specifier.endsWith(".ts") || specifier.endsWith(".tsx")) {
    return specifier.replace(/\.tsx?$/, ".js");
  }
  if (path.extname(specifier)) {
    return specifier;
  }

  const absoluteBase = path.resolve(path.dirname(importerPath), specifier);
  if (existsSync(`${absoluteBase}.ts`) || existsSync(`${absoluteBase}.tsx`)) {
    return `${specifier}.js`;
  }
  if (
    existsSync(path.join(absoluteBase, "index.ts")) ||
    existsSync(path.join(absoluteBase, "index.tsx"))
  ) {
    return `${specifier}/index.js`;
  }
  return specifier;
}

/**
 * esbuild plugin that rewrites relative TypeScript import specifiers to
 * runtime `.js` specifiers before esbuild compiles. With `bundle: false`,
 * esbuild does per-file transpilation and leaves import specifiers unchanged
 * in the emitted code — so source like `from "./foo"` can make Bun/Node walk
 * into a sibling `.d.ts` file instead of `dist/foo.js`.
 */
const rewriteRelativeTsExtensions = {
  name: "rewrite-relative-ts-extensions",
  setup(build: EsbuildPluginBuild) {
    build.onLoad({ filter: /\.(ts|tsx)$/ }, async (args) => {
      const source = await fsp.readFile(args.path, "utf8");
      const transformed = source.replace(
        /((?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\bexport\s+(?:\*|\{[^}]*\})\s+from\s+)["'])(\.\.?\/[^"']+?)(["'])/g,
        (_match, prefix: string, specifier: string, suffix: string) =>
          `${prefix}${resolveRelativeRuntimeSpecifier(args.path, specifier)}${suffix}`,
      );
      return {
        contents: transformed,
        loader: args.path.endsWith(".tsx") ? "tsx" : "ts",
      };
    });
  },
};

/** Transpile workspace plugins/apps under `plugins/*` without bundling deps. */
const packageRoot = resolvePackageRoot();
const outDir = "dist";

// tsup's internal clean unlinks individual outputs and can race itself on
// multi-entry packages. Force-removing the directory once is idempotent.
rmSync(path.join(packageRoot, outDir), { recursive: true, force: true });

export default {
  entry: collectSrcEntries(path.join(packageRoot, "src")),
  outDir,
  format: ["esm"],
  clean: false,
  sourcemap: true,
  dts: false,
  bundle: false,
  splitting: false,
  treeshake: false,
  external: [/^@elizaos\//, /^node:/],
  esbuildPlugins: [rewriteRelativeTsExtensions],
  esbuildOptions(options: { jsx?: string; packages?: string }) {
    options.jsx ??= "automatic";
    options.packages = "external";
    return options;
  },
};
