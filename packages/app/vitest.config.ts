import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "../../packages/test/vitest/default.config";

const here = path.dirname(fileURLToPath(import.meta.url));

const unitExcludes = [
  "dist/**",
  "**/node_modules/**",
  "**/*.live.test.{ts,tsx}",
  "**/*.real.test.{ts,tsx}",
  "**/*.integration.test.{ts,tsx}",
  "**/*.e2e.test.{ts,tsx}",
  "**/*.e2e.spec.{ts,tsx}",
  "**/*.spec.{ts,tsx}",
  "test/ui-smoke/**",
  "test/electrobun-packaged/**",
];

export default defineConfig({
  ...baseConfig,
  root: here,
  resolve: {
    ...baseConfig.resolve,
    // `@elizaos/ui/components/voice-pill` resolves through the package export
    // map to unbuilt `dist/components/voice-pill.js`, which vitest can't find.
    // Source-alias the one deep subpath an app test imports (AndroidVoicePill)
    // ahead of the base aliases so it resolves without a ui dist build.
    alias: [
      {
        find: /^@elizaos\/ui\/components\/voice-pill$/,
        replacement: path.resolve(
          here,
          "../ui/src/components/voice-pill/index.ts",
        ),
      },
      ...(baseConfig.resolve?.alias ?? []),
    ],
  },
  test: {
    ...baseConfig.test,
    environment: "jsdom",
    setupFiles: [path.join(here, "test/setup.ts")],
    include: [
      "src/**/*.test.{ts,tsx}",
      "scripts/**/*.test.{ts,tsx,mjs}",
      "test/**/*.test.{ts,tsx}",
    ],
    exclude: unitExcludes,
  },
});
