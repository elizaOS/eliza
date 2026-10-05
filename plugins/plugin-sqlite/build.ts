#!/usr/bin/env bun
/** Builds the shared persistent adapter with runtime-selected native SQLite drivers. */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-sqlite",
  clean: true,
  externals: [
    "@elizaos/core",
    "node:sqlite",
    "bun:sqlite",
    "devalue",
    "sql.js",
  ],
  targets: [
    {
      label: "Node",
      entry: "./index.ts",
      outSubdir: ".",
      target: "node",
      format: "esm",
    },
  ],
  dtsProject: "tsconfig.build.json",
  dtsEmitDeclarationOnly: true,
});

// Static builtin imports avoid Bun's createRequire(import.meta.url) wrapper,
// because Workerd has no module URL for that Node-only require factory.
const portable = await Bun.build({
  entrypoints: ["./portable.ts"],
  outdir: "./dist",
  target: "node",
  format: "esm",
  sourcemap: "external",
  minify: true,
  external: ["@elizaos/core", "devalue", "node:*"],
  plugins: [
    {
      name: "portable-sqlite-builtins",
      setup(build) {
        build.onLoad({ filter: /sql-asm\.js$/ }, async ({ path }) => {
          let contents = await Bun.file(path).text();
          for (const [module, binding] of [
            ["node:fs", "sqliteNodeFs"],
            ["node:crypto", "sqliteNodeCrypto"],
          ] as const) {
            const requireCall = `require("${module}")`;
            if (!contents.includes(requireCall))
              throw new Error(`sql.js builtin changed: ${module}`);
            contents =
              `import * as ${binding} from "${module}";\n` +
              contents.replaceAll(requireCall, binding);
          }
          return {
            contents: `const __filename = "sql-asm.js";\n${contents}`,
            loader: "js",
          };
        });
      },
    },
  ],
});
if (!portable.success)
  throw new AggregateError(portable.logs, "Portable SQLite build failed");
