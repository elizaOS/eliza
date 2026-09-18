/** Publish the runner with its private fixture implementation bundled, not imported. */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "tsup";

const root = fileURLToPath(new URL(".", import.meta.url));
const manifest = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);
const entries = readdirSync(`${root}src`, { recursive: true })
  .map((file) => String(file).replaceAll("\\", "/"))
  .filter(
    (file) =>
      file.endsWith(".ts") &&
      !file.endsWith(".test.ts") &&
      !file.includes("__tests__/") &&
      !file.endsWith(".d.ts"),
  );
await build({
  entry: Object.fromEntries(
    entries.map((file) => [file.slice(0, -3), `${root}src/${file}`]),
  ),
  outDir: `${root}dist`,
  tsconfig: `${root}tsconfig.build.json`,
  platform: "node",
  target: "node24",
  format: ["esm"],
  splitting: true,
  dts: { resolve: [/^@elizaos\/testing(?:\/|$)/] },
  external: [
    ...Object.keys(manifest.dependencies),
    "@elizaos/scenario-runner/schema",
  ],
  noExternal: [/^@elizaos\/testing(?:\/|$)/],
  clean: true,
});
