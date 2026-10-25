/** Resolve native inputs in both repository tooling and the published dist/engine bundles. */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const published = path.basename(path.dirname(here)) === "dist";
export const engineRoot = path.resolve(
  here,
  published
    ? "../../engine"
    : "../../../../../plugins/plugin-native-bun-runtime/engine",
);
export const rmPathRecursiveScript = path.resolve(
  here,
  published ? "rm-path-recursive.mjs" : "../../../rm-path-recursive.ts",
);
