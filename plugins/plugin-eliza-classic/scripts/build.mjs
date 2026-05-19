import { mkdir, writeFile } from "node:fs/promises";

const result = await Bun.build({
  entrypoints: ["index.ts", "index.browser.ts"],
  outdir: "dist",
  target: "node",
  format: "esm",
  sourcemap: "external",
  external: ["@elizaos/core"],
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

await mkdir("dist", { recursive: true });

const declarations = `import type { Plugin } from "@elizaos/core";

export declare function getElizaGreeting(): string;
export declare function generateElizaResponse(input: string): string;
export declare const elizaClassicPlugin: Plugin;
export declare const plugin: Plugin;
export default elizaClassicPlugin;
`;

await writeFile("dist/index.d.ts", declarations);
await writeFile(
  "dist/index.browser.d.ts",
  `export * from "./index";
export { default } from "./index";
`,
);
