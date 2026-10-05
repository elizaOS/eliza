/** Selects workspace entry readiness without applying host Bun conditions to browser bundles. */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { legacy, exports as resolveExports } from "resolve.exports";

export function canUseWorkspaceEntry(
  specifier: string,
  packageDir: string,
  target = "bun",
) {
  if (target === "browser") {
    const manifest = JSON.parse(
      readFileSync(path.join(packageDir, "package.json"), "utf8"),
    );
    const subpath = specifier.split("/").slice(2).join("/");
    let exported: ReturnType<typeof resolveExports> = [];
    try {
      exported = resolveExports(manifest, specifier, { browser: true });
    } catch (error) {
      // error-policy:J3 an unavailable export selects the existing source fallback.
      if (
        error instanceof Error &&
        (error.message.startsWith("Missing ") ||
          error.message.startsWith("No known conditions "))
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

  let resolved: string;
  try {
    resolved = Bun.resolveSync(specifier, packageDir);
  } catch (error) {
    // error-policy:J3 an unbuilt export selects the existing source fallback.
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ERR_MODULE_NOT_FOUND"
    )
      return false;
    throw error;
  }
  const root = realpathSync(packageDir);
  const entry = realpathSync(resolved);
  return entry.startsWith(`${root}${path.sep}`) && statSync(entry).isFile();
}

/** Resolves unbuilt workspace imports from the same platform source entry used by the mobile bundle. */
export function findWorkspaceSourceEntry(
  packageDir: string,
  subpath: string,
  target = "bun",
) {
  // Export aliases can point into nested source directories; guessing src/<subpath>
  // loses those mappings in a clean checkout without distribution outputs.
  {
    const manifest = JSON.parse(
      readFileSync(path.join(packageDir, "package.json"), "utf8"),
    );
    let exported: ReturnType<typeof resolveExports> = [];
    try {
      exported = resolveExports(
        manifest,
        subpath ? `./${subpath}` : ".",
        target === "browser"
          ? { browser: true }
          : { conditions: ["eliza-source", "bun", "node"], unsafe: true },
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        (!error.message.startsWith("Missing ") &&
          !error.message.startsWith("No known conditions "))
      )
        throw error;
    }
    for (const exportedPath of exported ?? []) {
      // Browser exports may name an unbuilt nested SDK rather than src/index.
      // Preserve the browser-selected path instead of enabling Node conditions.
      const candidate =
        target === "browser" && exportedPath.startsWith("./dist/")
          ? exportedPath
              .replace(/^\.\/dist\//, "./src/")
              .replace(/\.js$/, ".ts")
          : exportedPath;
      const entry = path.resolve(packageDir, candidate);
      if (
        /\.(?:[cm]?ts|tsx)$/.test(candidate) &&
        !candidate.endsWith(".d.ts") &&
        existsSync(entry) &&
        statSync(entry).isFile() &&
        realpathSync(entry).startsWith(`${realpathSync(packageDir)}${path.sep}`)
      )
        return entry;
    }
  }
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
    if (
      existsSync(full) &&
      statSync(full).isFile() &&
      realpathSync(full).startsWith(`${realpathSync(packageDir)}${path.sep}`)
    )
      return full;
  }
  return undefined;
}
