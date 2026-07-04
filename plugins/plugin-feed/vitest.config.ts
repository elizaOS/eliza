import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "../../packages/test/vitest/default.config";

const here = path.dirname(fileURLToPath(import.meta.url));
const baseAliases = Array.isArray(baseConfig.resolve?.alias)
  ? baseConfig.resolve.alias
  : [];

function resolveStorePackageDir(packageName: string): string | null {
  const store = path.join(here, "../../node_modules/.bun");
  const prefix = `${packageName.replace("/", "+")}@`;
  try {
    const entry = readdirSync(store).find((dir) => dir.startsWith(prefix));
    return entry ? path.join(store, entry, "node_modules", packageName) : null;
  } catch {
    return null;
  }
}

function packageAliases(packageName: string): Array<{
  find: RegExp;
  replacement: string;
}> {
  const dir = resolveStorePackageDir(packageName);
  if (!dir) return [];
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    { find: new RegExp(`^${escaped}$`), replacement: dir },
    {
      find: new RegExp(`^${escaped}/(.+)$`),
      replacement: path.join(dir, "$1"),
    },
  ];
}

const storePackageAliases = [
  ...packageAliases("react-router-dom"),
  ...packageAliases("@date-fns/tz"),
  ...packageAliases("react-syntax-highlighter"),
  ...(() => {
    const refractorDir = resolveStorePackageDir("refractor");
    return refractorDir
      ? [
          {
            find: /^refractor\/bash$/,
            replacement: path.join(refractorDir, "lang/bash.js"),
          },
        ]
      : [];
  })(),
];

const liveOnlyExcludes = [
  "dist/**",
  "**/node_modules/**",
  "**/*.live.test.{ts,tsx}",
  "**/*.live.e2e.test.{ts,tsx}",
  "**/*.real.test.{ts,tsx}",
  "**/*.real.e2e.test.{ts,tsx}",
  "**/*.integration.test.{ts,tsx}",
  "**/*.e2e.test.{ts,tsx}",
];

export default defineConfig({
  ...baseConfig,
  resolve: {
    ...baseConfig.resolve,
    alias: [...storePackageAliases, ...baseAliases],
  },
  test: {
    ...baseConfig.test,
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
    exclude: liveOnlyExcludes,
    passWithNoTests: false,
  },
});
