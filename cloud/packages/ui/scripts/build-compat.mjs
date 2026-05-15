import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoDir = path.resolve(packageDir, "../../..");
const sourceDir = path.join(repoDir, "packages/ui/src/cloud-ui");
const distDir = path.join(packageDir, "dist");
const defaultExportSubpaths = new Set(["runtime/dynamic", "runtime/image"]);

async function listSourceModules(dir = sourceDir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const modules = [];

  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      modules.push(...(await listSourceModules(absolute)));
      continue;
    }

    if (!/\.(ts|tsx)$/.test(entry.name) || entry.name.endsWith(".d.ts")) {
      continue;
    }

    const relative = path.relative(sourceDir, absolute).replace(/\\/g, "/");
    const subpath = relative.replace(/\.(ts|tsx)$/, "");
    if (subpath === "index") {
      continue;
    }
    modules.push(subpath);
  }

  return modules;
}

async function writeProxy(subpath) {
  const target = `@elizaos/ui/cloud-ui/${subpath}`;
  const outputPath = path.join(distDir, `${subpath}.js`);
  const declarationPath = path.join(distDir, `${subpath}.d.ts`);
  const reexports = [`export * from "${target}";`];

  if (defaultExportSubpaths.has(subpath)) {
    reexports.push(`export { default } from "${target}";`);
  }

  const content = `${reexports.join("\n")}\n`;
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content);
  await writeFile(declarationPath, content);
}

await rm(distDir, { recursive: true, force: true });
await mkdir(path.join(distDir, "styles"), { recursive: true });
await writeFile(distDir + "/index.js", 'export * from "@elizaos/ui/cloud-ui";\n');
await writeFile(distDir + "/index.d.ts", 'export * from "@elizaos/ui/cloud-ui";\n');
await writeFile(distDir + "/index.css", '@import "@elizaos/ui/cloud-ui/styles";\n');
await writeFile(distDir + "/styles/docs.css", '@import "@elizaos/ui/cloud-ui/styles/docs.css";\n');

for (const subpath of await listSourceModules()) {
  await writeProxy(subpath);
}
