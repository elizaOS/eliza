import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BunPlugin } from "bun";

const UUID_14_NODE_BARREL =
  /[\\/]uuid@14\.0\.2[\\/]node_modules[\\/]uuid[\\/]dist-node[\\/]index\.js$/;
const UUID_REEXPORT =
  /^export \{ default as ([A-Za-z][A-Za-z0-9]*) \} from '(\.\/[A-Za-z][A-Za-z0-9]*\.js)';$/;

// Bun 1.4.2 can drop ESM re-export bindings in the Android agent bundle.
// Keep the real UUID modules and give Bun a CommonJS namespace to bundle.
export const mobileUuidExportsPlugin: BunPlugin = {
  name: "eliza-mobile-uuid-exports",
  setup(build) {
    build.onLoad({ filter: UUID_14_NODE_BARREL }, async ({ path: filename }) => {
      const lines = (await readFile(filename, "utf8")).trim().split(/\r?\n/);
      const names = new Set<string>();
      const exports = lines.map((line) => {
        const entry = UUID_REEXPORT.exec(line);
        if (!entry) throw new Error("Unexpected UUID 14.0.2 Node export");
        const [, name, relative] = entry;
        names.add(name);
        const source = JSON.stringify(
          path.resolve(path.dirname(filename), relative),
        );
        return `  ${name}: require(${source}).default,`;
      });
      if (lines.length !== 14 || names.size !== lines.length) {
        throw new Error("Unexpected UUID 14.0.2 Node export layout");
      }
      return {
        loader: "js",
        contents: ["module.exports = {", ...exports, "};"].join("\n"),
      };
    });
  },
};
