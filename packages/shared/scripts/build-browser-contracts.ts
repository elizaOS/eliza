/** Bundle shared browser contracts and declarations without the Node runtime. */
import { fileURLToPath } from "node:url";
import { build } from "tsup";

const root = fileURLToPath(new URL("../", import.meta.url));
await build({
  entry: {
    "browser-contracts.browser": `${root}scripts/browser-contracts-entry.ts`,
    "browser-logger": `${root}scripts/browser-logger.ts`,
  },
  outDir: `${root}dist`,
  tsconfig: `${root}tsconfig.build.json`,
  platform: "browser",
  target: "es2022",
  format: ["esm"],
  splitting: false,
  dts: { compilerOptions: { rootDir: "../.." } },
  clean: false,
});
