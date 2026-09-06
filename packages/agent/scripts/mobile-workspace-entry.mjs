/** Selects workspace entry readiness without applying host Bun conditions to browser bundles. */
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export function canUseWorkspaceEntry(specifier, packageDir, target = "bun") {
  if (target === "browser") {
    // Bun.resolveSync uses host conditions. Preserve the browser bundler's
    // existing resolution so a browser-only export never selects Node source.
    const distDir = path.join(packageDir, "dist");
    if (!existsSync(distDir)) return false;
    const subpath = specifier.split("/").slice(2).join("/");
    if (!subpath) return true;
    const cleaned = subpath.replace(/\.js$/, "");
    return [`${cleaned}.js`, `${cleaned}/index.js`, cleaned].some((entry) =>
      existsSync(path.join(distDir, entry)),
    );
  }
  let resolved;
  try {
    resolved = Bun.resolveSync(specifier, packageDir);
  } catch (error) {
    // error-policy:J3 an unbuilt export selects the existing source fallback.
    if (error.code === "ERR_MODULE_NOT_FOUND") return false;
    throw error;
  }
  const root = realpathSync(packageDir);
  const entry = realpathSync(resolved);
  return entry.startsWith(`${root}${path.sep}`) && statSync(entry).isFile();
}
