/**
 * Declares side-effect app modules that must stay visible to the renderer
 * bundler.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Manifest-driven discovery of renderer side-effect app modules.
 *
 * App plugins that need to register UI surfaces/pages at app boot self-declare
 * `"elizaos": { "appRegister": "register" | "ui" }` in their own package.json.
 * The renderer build scans for that marker instead of the app shell hardcoding a
 * loader list, so adding or deleting a plugin directory needs zero app-side edits.
 *
 * `"register"` imports the plugin's `src/register.ts`; `"ui"` imports its
 * `src/ui.ts` (or `src/ui/index.ts`). The module is imported by absolute path so
 * no per-plugin Vite alias is required for the boot set.
 */

export type AppRegisterMode = "register" | "ui";

export type SideEffectAppModule = {
  /** Canonical package name — used as the dedupe key + load log label. */
  key: string;
  /** Absolute path to the renderer registration entry imported at boot. */
  entry: string;
};

const UI_ENTRY_CANDIDATES = ["src/ui.ts", "src/ui/index.ts"];
const REGISTER_ENTRY = "src/register.ts";

function resolveRegistrationEntry(
  pkgDir: string,
  mode: AppRegisterMode,
): string | null {
  if (mode === "register") {
    const candidate = path.join(pkgDir, REGISTER_ENTRY);
    return fs.existsSync(candidate) ? candidate : null;
  }
  for (const relative of UI_ENTRY_CANDIDATES) {
    const candidate = path.join(pkgDir, relative);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Scan the given package roots (e.g. `plugins/`, `packages/`) for app plugins
 * that declare `elizaos.appRegister`, returning their canonical name + the
 * absolute path to import for renderer side-effect registration. Sorted by name
 * so the generated module is deterministic.
 *
 * Throws if a plugin declares the marker but its entry file is missing — a
 * broken pipeline should fail the build loudly, not silently drop the plugin.
 */
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
      } catch {
        continue;
      }

      const mode = pkg.elizaos?.appRegister;
      if (mode !== "register" && mode !== "ui") continue;
      const name = pkg.name;
      if (typeof name !== "string" || seen.has(name)) continue;

      const entry = resolveRegistrationEntry(pkgDir, mode);
      if (!entry) {
        throw new Error(
          `[app-side-effect-modules] ${name} declares elizaos.appRegister:"${mode}" but no ${mode === "register" ? REGISTER_ENTRY : UI_ENTRY_CANDIDATES.join(" / ")} exists under ${pkgDir}`,
        );
      }
      seen.add(name);
      discovered.push({ key: name, entry });
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
        .map(
          (module) =>
            `  { key: ${JSON.stringify(module.key)}, load: () => import(${JSON.stringify(module.entry)}) },`,
        )
        .join("\n");
      return {
        code: code.replace(LOADERS_MARKER, `[\n${entries}\n]`),
        map: null,
      };
    },
  };
}
