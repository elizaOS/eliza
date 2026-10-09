import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";

function sourceExport(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  for (const condition of ["eliza-source", "bun", "import", "default"]) {
    if (value[condition]) {
      const found = sourceExport(value[condition]);
      if (found) return found;
    }
  }
  return null;
}

/** Bun source composition for an external host; only declared source exports are admitted. */
export function createConsumerSourceResolver({
  sourceRoot,
  consumerRoots = [],
}) {
  const root = realpathSync(sourceRoot);
  const externalRoots = [
    root,
    ...consumerRoots.map((directory) => realpathSync(directory)),
  ];
  const inside = (file, directory) =>
    file === directory || file.startsWith(directory + path.sep);
  const registry = new Map();
  for (const group of ["packages", "plugins"]) {
    for (const entry of readdirSync(path.join(root, group), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, group, entry.name);
      const file = path.join(dir, "package.json");
      if (!existsSync(file)) continue;
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      if (!manifest.name) continue;
      if (registry.has(manifest.name))
        throw new Error(`Duplicate source package ${manifest.name}`);
      registry.set(manifest.name, { dir, manifest });
    }
  }
  const resolvedSources = new Map();
  const plugin = {
    name: "eliza-consumer-source",
    setup(build) {
      build.onResolve({ filter: /^@elizaos\// }, (args) => {
        const parts = args.path.split("/");
        const name = parts.slice(0, 2).join("/");
        const subpath =
          parts.length === 2 ? "." : `./${parts.slice(2).join("/")}`;
        const pkg = registry.get(name);
        if (!pkg) throw new Error(`Unknown source package ${name}`);
        const exports = pkg.manifest.exports ?? {};
        let target;
        if (Object.hasOwn(exports, subpath)) {
          target = sourceExport(exports[subpath]);
        } else {
          const patterns = Object.keys(exports)
            .filter((key) => key.includes("*"))
            .sort((a, b) => b.length - a.length);
          for (const key of patterns) {
            const [start, end] = key.split("*");
            if (!subpath.startsWith(start) || !subpath.endsWith(end)) continue;
            const match = subpath.slice(
              start.length,
              subpath.length - end.length || undefined,
            );
            const template = sourceExport(exports[key]);
            target = template?.replaceAll("*", match);
            break; // A denied matching export must not fall through to a broader pattern.
          }
        }
        if (!target) throw new Error(`No permitted source export ${args.path}`);
        const resolved = path.resolve(pkg.dir, target);
        // Only a `dist` segment inside the package is compiled output; the
        // checkout itself may live under a directory named `dist`.
        if (
          !inside(resolved, pkg.dir) ||
          path.relative(pkg.dir, resolved).split(path.sep).includes("dist")
        ) {
          throw new Error(`Source-only resolver rejected ${args.path}`);
        }
        const real = realpathSync(resolved);
        if (!inside(real, pkg.dir))
          throw new Error(`Source export escapes its package ${args.path}`);
        resolvedSources.set(args.path, path.relative(root, real));
        return { path: real };
      });
      build.onResolve({ filter: /^[^./]/ }, (args) => {
        if (
          args.path.startsWith("@elizaos/") ||
          args.path.includes(":") ||
          builtinModules.includes(args.path)
        )
          return;
        if (externalRoots.some((directory) => inside(args.importer, directory)))
          return { path: args.path, external: true };
      });
    },
  };
  return { plugin, resolvedSources };
}
