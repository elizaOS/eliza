import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: false,
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: [
      { find: /^@elizaos\/cloud-ui$/, replacement: r("../../packages/ui/src/index.ts") },
      {
        find: /^@elizaos\/cloud-ui\/brand$/,
        replacement: r("../../packages/ui/src/components/brand/index.ts"),
      },
      {
        find: /^@elizaos\/cloud-ui\/layout$/,
        replacement: r("../../packages/ui/src/components/layout/index.ts"),
      },
      {
        find: /^@elizaos\/cloud-ui\/primitives$/,
        replacement: r("../../packages/ui/src/components/primitives.ts"),
      },
      { find: /^@elizaos\/cloud-ui\/(.*)$/, replacement: r("../../packages/ui/src") + "/$1" },
      { find: /^@\/lib(\/.*)?$/, replacement: r("../../packages/lib") + "$1" },
      { find: /^@\/db(\/.*)?$/, replacement: r("../../packages/db") + "$1" },
      { find: /^@\/types(\/.*)?$/, replacement: r("../../packages/types") + "$1" },
      {
        find: /^@\/components(\/.*)?$/,
        replacement: r("../../packages/ui/src/components") + "$1",
      },
      { find: /^@\/packages(\/.*)?$/, replacement: r("../../packages") + "$1" },
      { find: /^@\/(.*)$/, replacement: r("./src") + "/$1" },
    ],
  },
});
