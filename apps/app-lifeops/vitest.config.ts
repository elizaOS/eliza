import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "../../../test/vitest/default.config";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const packageRootFromRepo = path
  .relative(repoRoot, here)
  .split(path.sep)
  .join("/");
const appCoreTestSetup = path.resolve(
  here,
  "..",
  "..",
  "packages",
  "app-core",
  "test",
  "setup.ts",
);

const defaultUnitExcludes = [
  "dist/**",
  "**/node_modules/**",
  "**/*-live.test.{ts,tsx}",
  "**/*.live.test.{ts,tsx}",
  "**/*-real.test.{ts,tsx}",
  "**/*.real.test.{ts,tsx}",
  "**/*.integration.test.{ts,tsx}",
  "**/*.e2e.test.{ts,tsx}",
  "**/*.e2e.spec.{ts,tsx}",
  "**/*.live.e2e.test.{ts,tsx}",
  "**/*.real.e2e.test.{ts,tsx}",
];

export default defineConfig({
  ...baseConfig,
  root: repoRoot,
  test: {
    ...baseConfig.test,
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
    include: [
      `${packageRootFromRepo}/src/**/*.test.ts`,
      `${packageRootFromRepo}/src/**/*.test.tsx`,
      `${packageRootFromRepo}/test/**/*.test.ts`,
      `${packageRootFromRepo}/test/**/*.test.tsx`,
      `${packageRootFromRepo}/extensions/**/*.test.ts`,
      `${packageRootFromRepo}/extensions/**/*.test.tsx`,
    ],
    exclude: defaultUnitExcludes,
    setupFiles: [appCoreTestSetup],
  },
});
