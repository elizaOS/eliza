import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { build } from "bun";

const ROOT = resolve(dirname(import.meta.path));
const DIST = join(ROOT, "dist");

if (existsSync(DIST)) {
  rmSync(DIST, { recursive: true });
}
mkdirSync(DIST, { recursive: true });
mkdirSync(join(DIST, "node"), { recursive: true });
mkdirSync(join(DIST, "browser"), { recursive: true });
mkdirSync(join(DIST, "cjs"), { recursive: true });

console.log("Building Node.js ESM bundle...");
await build({
  entrypoints: [join(ROOT, "index.ts")],
  outdir: join(DIST, "node"),
  target: "node",
  format: "esm",
  splitting: false,
  sourcemap: "linked",
  minify: false,
  external: ["@elizaos/core", "ai", "@openrouter/ai-sdk-provider", "@ai-sdk/openai", "undici"],
  naming: {
    entry: "index.node.js",
  },
});

console.log("Building Browser ESM bundle...");
await build({
  entrypoints: [join(ROOT, "index.ts")],
  outdir: join(DIST, "browser"),
  target: "browser",
  format: "esm",
  splitting: false,
  sourcemap: "linked",
  minify: false,
  external: ["@elizaos/core", "ai", "@openrouter/ai-sdk-provider", "@ai-sdk/openai", "undici"],
  naming: {
    entry: "index.browser.js",
  },
});

console.log("Building CJS bundle...");
await build({
  entrypoints: [join(ROOT, "index.ts")],
  outdir: join(DIST, "cjs"),
  target: "node",
  format: "cjs",
  splitting: false,
  sourcemap: "linked",
  minify: false,
  external: ["@elizaos/core", "ai", "@openrouter/ai-sdk-provider", "@ai-sdk/openai", "undici"],
  naming: {
    entry: "index.node.cjs",
  },
});

console.log("Writing minimal TypeScript declarations...");
const { mkdir, writeFile } = await import("node:fs/promises");
await mkdir("dist/node", { recursive: true });
await mkdir("dist/browser", { recursive: true });
await mkdir("dist/cjs", { recursive: true });

const rootDeclaration = `import type { Plugin } from "@elizaos/core";

export declare const openrouterPlugin: Plugin;
declare const _default: Plugin;
export default _default;
`;

const reexportDeclaration = `export * from '../index';
export { default } from '../index';
`;

await writeFile("dist/index.d.ts", rootDeclaration);
await writeFile("dist/node/index.d.ts", reexportDeclaration);
await writeFile("dist/browser/index.d.ts", reexportDeclaration);
await writeFile("dist/cjs/index.d.ts", reexportDeclaration);

console.log("Build complete!");
