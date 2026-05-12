import { existsSync, readdirSync, promises as fsp } from "node:fs";
import path from "node:path";

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

/**
 * esbuild plugin that rewrites relative `.ts` / `.tsx` import specifiers to
 * `.js` before esbuild compiles. With `bundle: false`, esbuild does per-file
 * transpilation and leaves import specifiers unchanged in the emitted code —
 * so source like `from "./foo.tsx"` becomes a literal `from "./foo.tsx"` in
 * the dist `.js` file, which Node ESM and Vite both refuse to resolve.
 */
const rewriteRelativeTsExtensions = {
  name: "rewrite-relative-ts-extensions",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setup(build: any) {
    build.onLoad({ filter: /\.(ts|tsx)$/ }, async (args: { path: string }) => {
      const source = await fsp.readFile(args.path, "utf8");
      const transformed = source.replace(
        /((?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\bexport\s+(?:\*|\{[^}]*\})\s+from\s+)["'])(\.\.?\/[^"']+?)\.(tsx?)(["'])/g,
        "$1$2.js$4",
      );
      return {
        contents: transformed,
        loader: args.path.endsWith(".tsx") ? "tsx" : "ts",
      };
    });
  },
};

/** Transpile workspace plugins/apps under `plugins/*` without bundling deps. */
export default {
  entry: collectSrcEntries(path.join(resolvePackageRoot(), "src")),
  outDir: "dist",
  format: ["esm"],
  clean: true,
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
