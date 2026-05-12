import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "../../test/vitest/default.config";
import { repoRoot } from "../../test/vitest/repo-root";
import { getElizaWorkspaceRoot } from "../../test/vitest/workspace-aliases";

const here = path.dirname(fileURLToPath(import.meta.url));
const elizaRoot = getElizaWorkspaceRoot(repoRoot);
const packageRootFromRepo = path
  .relative(elizaRoot, here)
  .split(path.sep)
  .join("/");
const appCoreTestSetup = path.join(
  elizaRoot,
  "packages",
  "app-core",
  "test",
  "setup.ts",
);
const lifeopsTestSetup = path.join(here, "test", "setup.ts");
const lifeopsTestStubsRoot = path.join(here, "test", "stubs");
const agentSourceRoot = path.join(elizaRoot, "packages", "agent", "src");
const corePackageRequire = createRequire(
  path.join(elizaRoot, "packages", "core", "package.json"),
);
const escapedAgentSourceRoot = agentSourceRoot.replace(
  /[.*+?^${}()|[\]\\]/g,
  "\\$&",
);
const agentSourceJsToTsPlugin = {
  name: "lifeops-agent-source-js-to-ts",
  enforce: "pre" as const,
  resolveId(source: string, importer?: string) {
    if (source === "@elizaos/agent") {
      return path.join(lifeopsTestStubsRoot, "agent.ts");
    }
    if (source === "@elizaos/ui") {
      return path.join(lifeopsTestStubsRoot, "ui.ts");
    }
    if (source === "@elizaos/plugin-google") {
      return path.join(lifeopsTestStubsRoot, "plugin-google.ts");
    }

    const normalizedImporter = importer?.replace(/^\/@fs/, "");
    if (
      normalizedImporter &&
      (source.startsWith("./") || source.startsWith("../")) &&
      source.endsWith(".js")
    ) {
      const candidate = path.resolve(path.dirname(normalizedImporter), source);
      if (candidate.startsWith(`${agentSourceRoot}${path.sep}`)) {
        const tsCandidate = candidate.slice(0, -".js".length) + ".ts";
        if (fs.existsSync(tsCandidate)) {
          return tsCandidate;
        }
      }
    }

    return null;
  },
};
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

function resolveCorePackageEntry(packageName: string): string {
  return corePackageRequire.resolve(packageName);
}

function resolveCorePackageRoot(packageName: string): string {
  return path.dirname(
    corePackageRequire.resolve(path.join(packageName, "package.json")),
  );
}

const reactRoot = resolveNodePackageRoot("react");
const reactDomRoot = resolveNodePackageRoot("react-dom");
const aiEntry = resolveCorePackageEntry("ai");
const fsExtraEntry = resolveCorePackageEntry("fs-extra");
const handlebarsEntry = resolveCorePackageEntry("handlebars");
const mammothEntry = resolveCorePackageEntry("mammoth");
const markdownItRoot = resolveCorePackageRoot("markdown-it");
const telegramSessionsEntry = path.join(
  elizaRoot,
  "plugins",
  "plugin-telegram",
  "node_modules",
  "telegram",
  "sessions",
  "index.js",
);
const pluginHealthSrc = path.join(elizaRoot, "plugins", "plugin-health", "src");

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
  root: elizaRoot,
  plugins: [
    ...(Array.isArray(baseConfig.plugins) ? baseConfig.plugins : []),
    agentSourceJsToTsPlugin,
  ],
  ssr: {
    ...baseConfig.ssr,
    noExternal: [
      "@elizaos/agent",
      "@elizaos/ui",
      ...(Array.isArray(baseConfig.ssr?.noExternal)
        ? baseConfig.ssr.noExternal
        : []),
    ],
  },
  resolve: {
    ...baseConfig.resolve,
    preserveSymlinks: false,
    alias: [
      // These packages are imported by @elizaos/core while this suite inlines
      // core. Resolve them through Bun's real package-store path so their own
      // nested dependencies remain visible with preserveSymlinks enabled.
      { find: /^ai$/, replacement: aiEntry },
      { find: /^fs-extra$/, replacement: fsExtraEntry },
      { find: /^handlebars$/, replacement: handlebarsEntry },
      { find: /^mammoth$/, replacement: mammothEntry },
      {
        find: /^markdown-it$/,
        replacement: path.join(markdownItRoot, "index.mjs"),
      },
      {
        find: new RegExp(`^${escapedAgentSourceRoot}/(.+)\\.js$`),
        replacement: `${agentSourceRoot}/$1.ts`,
      },
      {
        find: new RegExp(`^/@fs${escapedAgentSourceRoot}/(.+)\\.js$`),
        replacement: `${agentSourceRoot}/$1.ts`,
      },
      {
        find: "@elizaos/ui",
        replacement: path.join(lifeopsTestStubsRoot, "ui.ts"),
      },
      {
        find: "@elizaos/agent",
        replacement: path.join(lifeopsTestStubsRoot, "agent.ts"),
      },
      {
        find: /^@elizaos\/plugin-workflow$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-workflow",
          "src",
          "index.ts",
        ),
      },
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
        replacement: path.join(lifeopsTestStubsRoot, "plugin-google.ts"),
      },
      {
        find: /^@elizaos\/plugin-elizacloud$/,
        replacement: path.join(lifeopsTestStubsRoot, "plugin-elizacloud.ts"),
      },
      {
        find: /^@elizaos\/plugin-discord$/,
        replacement: path.join(lifeopsTestStubsRoot, "plugin-discord.ts"),
      },
      {
        find: /^@elizaos\/plugin-health$/,
        replacement: path.join(pluginHealthSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-health\/(.+)$/,
        replacement: path.join(pluginHealthSrc, "$1"),
      },
      ...(Array.isArray(baseConfig.resolve?.alias)
        ? baseConfig.resolve.alias
        : []),
      {
        find: "@elizaos/ui",
        replacement: path.join(lifeopsTestStubsRoot, "ui.ts"),
      },
      {
        find: "@elizaos/agent",
        replacement: path.join(lifeopsTestStubsRoot, "agent.ts"),
      },
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
    setupFiles: [lifeopsTestSetup, appCoreTestSetup],
    server: {
      ...baseConfig.test?.server,
      deps: {
        ...baseConfig.test?.server?.deps,
        inline: true,
      },
    },
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
