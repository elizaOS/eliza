/**
 * Declares side-effect app modules that must stay visible to the renderer
 * bundler.
 */
import fs from "node:fs";
import path from "node:path";

/** A callable browser registration export declared by a package manifest. */
export type SideEffectAppModule = {
  key: string;
  packageName: string;
  exportName: string;
  subpath?: string;
};

/** Discover callable browser registration exports, rejecting missing source entries. */
export function discoverSideEffectAppModules(
  packageRoots: readonly string[],
): SideEffectAppModule[] {
  const discovered: SideEffectAppModule[] = [];
  const seen = new Set<string>();

  for (const root of packageRoots) {
    if (!fs.existsSync(root)) continue;
    for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const pkgDir = path.join(root, dirent.name);
      const pkgPath = path.join(pkgDir, "package.json");
      if (!fs.existsSync(pkgPath)) continue;

      let pkg: { name?: unknown; elizaos?: { appRegister?: unknown } };
      try {
        pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      } catch (cause) {
        // error-policy:J2 identify the invalid manifest without dropping a plugin.
        throw new Error(`Invalid app plugin manifest: ${pkgPath}`, { cause });
      }

      const declaration = pkg.elizaos?.appRegister;
      if (typeof declaration === "object" && declaration !== null) {
        const name = pkg.name;
        if (typeof name !== "string" || seen.has(name)) continue;
        if (
          !("export" in declaration) ||
          typeof declaration.export !== "string" ||
          !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(declaration.export)
        ) {
          throw new Error(
            `[app-side-effect-modules] ${name} appRegister must name a root export`,
          );
        }
        const subpath =
          "subpath" in declaration ? declaration.subpath : undefined;
        if (
          subpath !== undefined &&
          (typeof subpath !== "string" ||
            !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(subpath))
        ) {
          throw new Error(
            `[app-side-effect-modules] ${name} appRegister subpath must name a package leaf`,
          );
        }
        const entry = (
          subpath
            ? [`src/${subpath}.ts`, `src/${subpath}.tsx`]
            : ["src/index.ts", "src/index.tsx", "index.ts"]
        )
          .map((relative) => path.join(pkgDir, relative))
          .find((candidate) => fs.existsSync(candidate));
        if (!entry) {
          throw new Error(
            `[app-side-effect-modules] ${name} has no package root source entry`,
          );
        }
        seen.add(name);
        discovered.push({
          key: `${name}#${subpath ? `leaf:${subpath}` : "root"}:${declaration.export}`,
          packageName: name,
          exportName: declaration.export,
          ...(subpath ? { subpath } : {}),
        });
        continue;
      }
      if (declaration !== undefined) {
        throw new Error(
          `[app-side-effect-modules] ${pkg.name} appRegister must name a root export`,
        );
      }
    }
  }

  discovered.sort((a, b) => a.key.localeCompare(b.key));
  return discovered;
}

// Marker in src/plugin-registrations.ts whose array literal the build rewrites
// with the manifest-scanned loaders. A `transform` hook (works identically under
// Rollup and the vite 8 / Rolldown production build) is used instead of a
// `virtual:` module — Rolldown does not resolve a static `export … from
// "virtual:…"` the way Rollup does.
const LOADERS_MARKER = "/* @__ELIZA_APP_REGISTER_LOADERS__ */ []";

function stripQuery(id: string): string {
  const q = id.indexOf("?");
  return q === -1 ? id : id.slice(0, q);
}

/**
 * Vite plugin that injects the manifest-driven side-effect loader list into
 * `src/plugin-registrations.ts` at build time.
 */
export function appSideEffectModulesPlugin(packageRoots: readonly string[]) {
  return {
    name: "eliza-side-effect-app-modules",
    // Run on the raw source before vite's TS transform so the marker is intact.
    enforce: "pre" as const,
    transform(code: string, id: string) {
      if (!stripQuery(id).endsWith("/src/plugin-registrations.ts")) return null;
      if (!code.includes(LOADERS_MARKER)) return null;
      const modules = discoverSideEffectAppModules(packageRoots);
      const entries = modules
        .map((module) => {
          const key = JSON.stringify(module.key);
          const specifier = JSON.stringify(
            module.subpath
              ? `${module.packageName}/${module.subpath}`
              : module.packageName,
          );
          return `  { key: ${key}, load: () => import(${specifier}).then(({ ${module.exportName}: register }) => { if (typeof register !== "function") throw new Error(${JSON.stringify(`${module.packageName} must export callable ${module.exportName}`)}); return register(); }) },`;
        })
        .join("\n");
      return {
        code: code.replace(LOADERS_MARKER, `[\n${entries}\n]`),
        map: null,
      };
    },
  };
}
