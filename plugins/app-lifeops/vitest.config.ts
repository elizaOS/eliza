import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "../../test/vitest/default.config";
import { repoRoot } from "../../test/vitest/repo-root";
import { getElizaWorkspaceRoot } from "../../test/vitest/workspace-aliases";

const here = path.dirname(fileURLToPath(import.meta.url));
const elizaRoot = getElizaWorkspaceRoot(repoRoot);
const packageRootFromRepo = path
  .relative(repoRoot, here)
  .split(path.sep)
  .join("/");
const appCoreTestSetup = path.join(
  elizaRoot,
  "packages",
  "app-core",
  "test",
  "setup.ts",
);
function resolveNodePackageRoot(packageName: string): string {
  const directCandidates = [
    path.join(here, "node_modules", packageName),
    path.join(elizaRoot, "node_modules", packageName),
    path.join(repoRoot, "node_modules", packageName),
  ];
  for (const candidate of directCandidates) {
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return candidate;
    }
  }

  const bunStoreRoot = path.join(repoRoot, "node_modules", ".bun");
  if (fs.existsSync(bunStoreRoot)) {
    const match = fs
      .readdirSync(bunStoreRoot)
      .find((entry) => entry.startsWith(`${packageName}@`));
    if (match) {
      return path.join(bunStoreRoot, match, "node_modules", packageName);
    }
  }

  return path.join(here, "node_modules", packageName);
}

const reactRoot = resolveNodePackageRoot("react");
const reactDomRoot = resolveNodePackageRoot("react-dom");
const telegramSessionsEntry = path.join(
  elizaRoot,
  "plugins",
  "plugin-telegram",
  "node_modules",
  "telegram",
  "sessions",
  "index.js",
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
  resolve: {
    ...baseConfig.resolve,
    alias: [
      {
        find: /^react\/jsx-dev-runtime$/,
        replacement: path.join(reactRoot, "jsx-dev-runtime.js"),
      },
      {
        find: /^react\/jsx-runtime$/,
        replacement: path.join(reactRoot, "jsx-runtime.js"),
      },
      { find: /^react$/, replacement: path.join(reactRoot, "index.js") },
      { find: /^react\/(.*)$/, replacement: path.join(reactRoot, "$1") },
      {
        find: /^react-dom\/client$/,
        replacement: path.join(reactDomRoot, "client.js"),
      },
      {
        find: /^react-dom\/server$/,
        replacement: path.join(reactDomRoot, "server.js"),
      },
      {
        find: /^react-dom\/test-utils$/,
        replacement: path.join(reactDomRoot, "test-utils.js"),
      },
      { find: /^react-dom$/, replacement: path.join(reactDomRoot, "index.js") },
      {
        find: /^react-dom\/(.*)$/,
        replacement: path.join(reactDomRoot, "$1"),
      },
      {
        find: /^@capacitor\/core$/,
        replacement: path.join(
          elizaRoot,
          "packages",
          "app-core",
          "test",
          "stubs",
          "capacitor-core.ts",
        ),
      },
      { find: /^telegram\/sessions$/, replacement: telegramSessionsEntry },
      {
        find: /^@elizaos\/plugin-calendly$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-calendly",
          "src",
          "index.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-google$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-google",
          "src",
          "index.ts",
        ),
      },
      ...(Array.isArray(baseConfig.resolve?.alias)
        ? baseConfig.resolve.alias
        : []),
    ],
  },
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
    coverage: {
      ...baseConfig.test?.coverage,
      include: [`${packageRootFromRepo}/src/**/*.{ts,tsx}`],
      exclude: [
        `${packageRootFromRepo}/src/**/*.test.{ts,tsx}`,
        `${packageRootFromRepo}/src/**/*.live.test.{ts,tsx}`,
        `${packageRootFromRepo}/src/**/*.real.test.{ts,tsx}`,
        `${packageRootFromRepo}/src/**/*.integration.test.{ts,tsx}`,
        `${packageRootFromRepo}/src/**/*.e2e.test.{ts,tsx}`,
        `${packageRootFromRepo}/src/**/*.live.e2e.test.{ts,tsx}`,
        `${packageRootFromRepo}/src/**/*.real.e2e.test.{ts,tsx}`,
      ],
    },
  },
});
