/** Publish one Node entry and declaration for the assistant policy plugin. */
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "tsup";

const root = fileURLToPath(new URL(".", import.meta.url));
const manifest = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);
await rm(`${root}dist`, { recursive: true, force: true });
await build({
  entry: { index: `${root}src/index.ts` },
  outDir: `${root}dist`,
  tsconfig: `${root}tsconfig.build.json`,
  platform: "node",
  target: "node24",
  format: ["esm"],
  splitting: false,
  dts: true,
  external: [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ],
  clean: true,
});
