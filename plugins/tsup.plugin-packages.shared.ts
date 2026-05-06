import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

function resolvePackageRoot(): string {
  // CWD wins when it points at a real package directory. A parent
  // process's `npm_package_json` env leaks into spawned children
  // (e.g. setup-upstreams runs `bun run build` from the milady root with
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
          /\.test\.(ts|tsx)$/.test(ent.name) ||
          /\.spec\.(ts|tsx)$/.test(ent.name)
        ) {
          continue;
        }
        out.push(path.relative(resolvePackageRoot(), full));
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
  esbuildOptions(options) {
    options.jsx ??= "automatic";
    options.packages = "external";
    return options;
  },
};
