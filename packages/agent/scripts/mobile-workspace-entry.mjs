/** Selects workspace entry readiness without applying host Bun conditions to browser bundles. */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { legacy, exports as resolveExports } from "resolve.exports";

export function canUseWorkspaceEntry(specifier, packageDir, target = "bun") {
  if (target === "browser") {
    const manifest = JSON.parse(
      readFileSync(path.join(packageDir, "package.json"), "utf8"),
    );
    const subpath = specifier.split("/").slice(2).join("/");
    let exported;
    try {
      exported = resolveExports(manifest, specifier, { browser: true });
    } catch (error) {
      // error-policy:J3 an unavailable export selects the existing source fallback.
      if (
        error.message.startsWith("Missing ") ||
        error.message.startsWith("No known conditions ")
      )
        return false;
      throw error;
    }
    const candidate =
      exported?.[0] ?? (subpath || legacy(manifest, { browser: true }));
    // Object browser maps remap individual imports; leave them to Bun when
    // the ordinary entry exists, rather than treating the map as a path.
    const relative =
      typeof candidate === "string"
        ? candidate
        : manifest.module || manifest.main || "index.js";
    const entry = path.resolve(packageDir, relative);
    const root = realpathSync(packageDir);
    return (
      existsSync(entry) &&
      realpathSync(entry).startsWith(`${root}${path.sep}`) &&
      statSync(entry).isFile()
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

/** Resolves unbuilt workspace imports from the same platform source entry used by the mobile bundle. */
export function findWorkspaceSourceEntry(packageDir, subpath, target = "bun") {
  const srcDir = existsSync(path.join(packageDir, "src"))
    ? path.join(packageDir, "src")
    : packageDir;
  const cleaned = subpath.replace(/\.js$/, "");
  const candidates = subpath
    ? [
        `${cleaned}.ts`,
        `${cleaned}.tsx`,
        `${cleaned}/index.ts`,
        `${cleaned}/index.tsx`,
        cleaned,
      ]
    : target === "browser"
      ? [
          "index.browser.ts",
          "index.browser.tsx",
          "index.ts",
          "index.tsx",
          "index.node.ts",
          "index.node.tsx",
        ]
      : ["index.node.ts", "index.ts", "index.tsx", "index.node.tsx"];
  for (const candidate of candidates) {
    const full = path.join(srcDir, candidate);
    if (existsSync(full) && statSync(full).isFile()) return full;
  }
  return undefined;
}
