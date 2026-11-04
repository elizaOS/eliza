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
    resolveEntry({ name: "vitest/config", importer: root + "/plugins/plugin-assistant/vitest.config.ts", ownerManifest: root + "/plugins/plugin-assistant/package.json", ownerName: "@elizaos/plugin-assistant" }),
    resolveEntry({ name: "vitest/config", importer: root + "/plugins/plugin-openai/vitest.config.ts", ownerManifest: root + "/plugins/plugin-openai/package.json", ownerName: "@elizaos/plugin-openai" }),
    resolveEntry({ name: "vite", importer: root + "/plugins/plugin-assistant/vitest.config.ts", ownerManifest: root + "/package.json", ownerName: "eliza" }),
    resolveEntry({ name: "vite", importer: root + "/plugins/plugin-openai/vitest.config.ts", ownerManifest: root + "/package.json", ownerName: "eliza" }),
    resolveEntry({ name: "ai", importer: root + "/plugins/plugin-openai/__tests__/qwen-response-schema.wire.test.ts", ownerManifest: root + "/plugins/plugin-openai/package.json", ownerName: "@elizaos/plugin-openai" }),
    resolveEntry({ name: "@ai-sdk/openai", importer: root + "/plugins/plugin-openai/models/text.ts", ownerManifest: root + "/plugins/plugin-openai/package.json", ownerName: "@elizaos/plugin-openai" }),
  ];
  if (entries.slice(0, 3).some(entry => entry.version !== "5.0.5")) throw new Error("Canonical Vitest 5.0.5 identity mismatch");
  if (entries.slice(3, 5).some(entry => entry.version !== "8.3.3")) throw new Error("Canonical Vite 8.3.3 identity mismatch");
  const cliSource=ownedFile(path.join(path.dirname(entries[0].packageManifest),"dist/chunks/cac.CLrZKo1g.js"));
  const cliBytes=fs.readFileSync(cliSource),cliSHA256=createHash("sha256").update(cliBytes).digest("hex");
  if(cliSHA256!=="cbe6e023d5b1e5c8de648da0d43242e660d88676b172a022d2b95f22a88b78c0"||!cliBytes.toString("utf8").includes("fsModuleCachePath:"))throw new Error("Locked actual CLI lacks reviewed writable cache option");
  return { node: process.versions.node, entries, fsModuleCachePathSupport:{cliSource,cliSHA256,option:"--fsModuleCachePath <path>",testsExecuted:false}, network: "container-none",
    scope: "Normal owner/wrapper package resolution only; no dependency entrypoint execution or SSR/test/native/financial acceptance" };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync("/results/BOOTSTRAP.json", JSON.stringify(inspectBootstrap("/workspace"), null, 2) + "\n");
}
