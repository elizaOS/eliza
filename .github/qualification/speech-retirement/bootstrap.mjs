/** Metadata-only resolution from the same owners as the actual commands/config.
 * No dependency entrypoint is imported or executed. The preceding frozen-lock
 * install and complete dependency census bind the actual installed versions.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export function inspectBootstrap(source) {
  const root = fs.realpathSync(source);
  const modules = root + "/node_modules/";
  const ownedFile = (file) => {
    const actual = fs.realpathSync(file);
    if (!actual.startsWith(root + "/") || !fs.statSync(actual).isFile()) {
      throw new Error("Bootstrap file is outside the admitted source");
    }
    return actual;
  };
  const resolveEntry = ({ name, importer, ownerManifest, ownerName }) => {
    importer = ownedFile(importer);
    ownerManifest = ownedFile(ownerManifest);
    const owner = JSON.parse(fs.readFileSync(ownerManifest, "utf8"));
    if (owner.name !== ownerName) throw new Error("Wrong canonical bootstrap owner: " + name);
    const packageName = name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0];
    const declared = owner.dependencies?.[packageName] ?? owner.devDependencies?.[packageName] ?? owner.optionalDependencies?.[packageName];
    if (typeof declared !== "string" || !declared) throw new Error("Bootstrap dependency is not declared by its canonical owner: " + name);
    const file = ownedFile(createRequire(importer).resolve(name));
    if (!file.startsWith(modules)) throw new Error("External dependency origin: " + name);
    let directory = path.dirname(file), manifest, metadata;
    while (directory.startsWith(modules)) {
      const candidate = path.join(directory, "package.json");
      if (fs.existsSync(candidate)) {
        const actual = ownedFile(candidate);
        if (!actual.startsWith(modules)) throw new Error("External package manifest: " + name);
        const value = JSON.parse(fs.readFileSync(actual, "utf8"));
        if (typeof value.name === "string") {
          manifest = actual;
          metadata = value;
          break;
        }
      }
      directory = path.dirname(directory);
    }
    if (!metadata || metadata.name !== packageName || typeof metadata.version !== "string") {
      throw new Error("Resolved bootstrap package identity mismatch: " + name);
    }
    // Exact pins can be checked directly. Range resolution remains bound by
    // the actual frozen lock/census, not a new ad-hoc semver implementation.
    if (/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(declared) && metadata.version !== declared) {
      throw new Error("Resolved bootstrap exact version mismatch: " + name);
    }
    return { name, importer, ownerManifest, ownerName, declared,
      packageName: metadata.name, version: metadata.version, packageManifest: manifest,
      file, sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
  };
  const entries = [
    resolveEntry({ name: "vitest/node", importer: root + "/node_modules/vitest/vitest.mjs", ownerManifest: root + "/package.json", ownerName: "eliza" }),
    resolveEntry({ name: "vitest/config", importer: root + "/plugins/plugin-calendar/vitest.config.ts", ownerManifest: root + "/plugins/plugin-calendar/package.json", ownerName: "@elizaos/plugin-calendar" }),
    resolveEntry({ name: "vite", importer: root + "/plugins/plugin-calendar/vitest.config.ts", ownerManifest: root + "/plugins/plugin-calendar/package.json", ownerName: "@elizaos/plugin-calendar" }),
    resolveEntry({ name: "typescript", importer: root + "/package.json", ownerManifest: root + "/package.json", ownerName: "eliza" }),
  ];
  for (const entry of entries) {
    const expected = { vitest: "5.0.5", vite: "8.3.3", typescript: "6.0.3" }[entry.packageName];
    if (entry.version !== expected) throw new Error("Canonical framework version mismatch: " + entry.name);
  }
  return { node: process.versions.node, entries, network: "container-none",
    scope: "Normal owner/wrapper package resolution only; no dependency entrypoint execution or SSR/test/native/financial acceptance" };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync("/results/BOOTSTRAP.json", JSON.stringify(inspectBootstrap("/workspace"), null, 2) + "\n");
}
