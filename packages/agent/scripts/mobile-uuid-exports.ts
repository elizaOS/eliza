import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BunPlugin } from "bun";

const UUID_14_NODE_BARREL =
  /[\\/]uuid@14\.0\.2[\\/]node_modules[\\/]uuid[\\/]dist-node[\\/]index\.js$/;
const UUID_REEXPORT =
  /^export \{ default as ([A-Za-z][A-Za-z0-9]*) \} from '(\.\/[A-Za-z][A-Za-z0-9]*\.js)';$/;

export interface MobileUuidTransform {
  path: string;
  sourceSha256: string;
  bridgeSha256: string;
}

// Bun 1.4.2 can drop ESM re-export bindings in the Android agent bundle.
// Keep the real UUID modules and give Bun a CommonJS namespace to bundle.
export function createMobileUuidExportsPlugin(
  root: string,
  transforms: MobileUuidTransform[],
): BunPlugin {
  return {
    name: "eliza-mobile-uuid-exports",
    setup(build) {
      build.onLoad(
        { filter: UUID_14_NODE_BARREL },
        async ({ path: filename }) => {
          const input = await readFile(filename, "utf8");
          const lines = input.trim().split(/\r?\n/);
          const names = new Set<string>();
          const entries = lines.map((line, index) => {
            const entry = UUID_REEXPORT.exec(line);
            if (!entry) throw new Error("Unexpected UUID 14.0.2 Node export");
            const [, name, relative] = entry;
            names.add(name);
            const source = JSON.stringify(
              path.resolve(path.dirname(filename), relative),
            );
            return { name, binding: `binding${index}`, source };
          });
          if (lines.length !== 14 || names.size !== lines.length) {
            throw new Error("Unexpected UUID 14.0.2 Node export layout");
          }
          const contents =
            entries
              .map(
                ({ binding, source }) =>
                  `var ${binding}=require(${source}).default;`,
              )
              .join("\n") +
            "\nmodule.exports={" +
            entries.map(({ name, binding }) => `${name}:${binding}`).join(",") +
            "};\n";
          transforms.push({
            path: path.relative(root, filename).split(path.sep).join("/"),
            sourceSha256: createHash("sha256").update(input).digest("hex"),
            bridgeSha256: createHash("sha256").update(contents).digest("hex"),
          });
          return { loader: "js", contents };
        },
      );
    },
  };
}
