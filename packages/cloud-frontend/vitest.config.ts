import { existsSync, statSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Mirrors the local-first / cloud-shared-fallback semantics from vite.config.ts.
function resolveLocalFirst(
  id: string,
  localBase: string,
  sharedBase: string,
): string {
  const sub = id.replace(/^@\/(?:lib|db|types|components)\/?/, "");
  const localPath = r(`${localBase}/${sub}`);
  const candidates = [
    localPath,
    `${localPath}.ts`,
    `${localPath}.tsx`,
    `${localPath}/index.ts`,
    `${localPath}/index.tsx`,
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  if (existsSync(localPath) && statSync(localPath).isDirectory()) {
    return localPath;
  }
  return r(`${sharedBase}/${sub}`);
}

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: false,
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
  },
  plugins: [
    {
      name: "eliza-cloud-frontend-alias-fallback",
      enforce: "pre",
      resolveId(source) {
        if (source === "@/lib/utils") {
          return r("./src/lib/utils.ts");
        }
        if (source.startsWith("@/lib/hooks/")) {
          return resolveLocalFirst(
            source,
            "./src/hooks",
            "../cloud-shared/src/lib/hooks",
          );
        }
        if (source.startsWith("@/lib/providers/")) {
          return resolveLocalFirst(
            source,
            "./src/providers",
            "../cloud-shared/src/lib/providers",
          );
        }
        if (source.startsWith("@/lib/stores/")) {
          return resolveLocalFirst(
            source,
            "./src/lib/stores",
            "../cloud-shared/src/lib/stores",
          );
        }
        if (source.startsWith("@/lib/")) {
          return resolveLocalFirst(
            source,
            "./src/lib",
            "../cloud-shared/src/lib",
          );
        }
        if (source.startsWith("@/db/")) {
          return resolveLocalFirst(
            source,
            "./src/db",
            "../cloud-shared/src/db",
          );
        }
        if (source.startsWith("@/types/")) {
          return resolveLocalFirst(
            source,
            "./src/types",
            "../cloud-shared/src/types",
          );
        }
        if (source.startsWith("@/components/")) {
          return resolveLocalFirst(
            source,
            "./src/components",
            "../ui/src/cloud-ui/components",
          );
        }
        return null;
      },
    },
  ],
  resolve: {
    alias: [
      { find: /^@elizaos\/ui$/, replacement: r("../ui/src/cloud-ui/index.ts") },
      {
        find: /^@elizaos\/ui\/primitives$/,
        replacement: r("../ui/src/cloud-ui/components/primitives.ts"),
      },
      {
        find: /^@elizaos\/ui\/brand$/,
        replacement: r("../ui/src/cloud-ui/components/brand/index.ts"),
      },
      {
        find: /^@elizaos\/ui\/layout$/,
        replacement: r("../ui/src/cloud-ui/components/layout/index.ts"),
      },
      { find: /^@elizaos\/ui\/(.*)$/, replacement: `${r("../ui/src")}/$1` },
      {
        find: /^@elizaos\/cloud-shared$/,
        replacement: r("../cloud-shared/src/index.ts"),
      },
      {
        find: /^@elizaos\/cloud-shared\/(.*)$/,
        replacement: `${r("../cloud-shared/src")}/$1`,
      },
      {
        find: /^@\/packages(\/.*)?$/,
        replacement: `${r("../cloud-shared/src")}$1`,
      },
      { find: /^@\/(.*)$/, replacement: `${r("./src")}/$1` },
    ],
  },
});
