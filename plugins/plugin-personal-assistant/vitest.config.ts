/**
 * Base Vitest configuration for the plugin: extends the repo default config and
 * wires the LifeOps and app-core test setup, stub roots, and workspace aliases
 * so unit specs resolve source and native-library policy correctly.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "../../packages/test/vitest/default.config";
import { repoRoot } from "../../packages/test/vitest/repo-root";
import { getElizaWorkspaceRoot } from "../../packages/test/vitest/workspace-aliases";

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
const appCoreNativeLibraryPolicy = path.join(
  elizaRoot,
  "packages",
  "app-core",
  "src",
  "platform",
  "native-library-policy.ts",
);
const appCoreTaskHostCapabilities = path.join(
  elizaRoot,
  "packages",
  "app-core",
  "src",
  "services",
  "task-host-capabilities.ts",
);
const agentSourceRoot = path.join(elizaRoot, "packages", "agent", "src");
const corePackageRequire = createRequire(
  path.join(elizaRoot, "packages", "core", "package.json"),
);
const escapedAgentSourceRoot = agentSourceRoot.replace(
  /[.*+?^${}()|[\]\\]/g,
  "\\$&",
);
const optionalCorePluginStubPrefix = "\0lifeops-optional-core-plugin-stub:";
const optionalCorePluginStubPackages = new Set([
  "@elizaos/plugin-agent-orchestrator",
  "@elizaos/plugin-task-coordinator",
  "@elizaos/plugin-app-control",
  "@elizaos/plugin-shell",
  "@elizaos/plugin-coding-tools",
  "@elizaos/plugin-commands",
  "@elizaos/plugin-video",
  "@elizaos/plugin-background-runner",
  "@elizaos/plugin-ollama",
  "@elizaos/plugin-anthropic",
  "@elizaos/plugin-openai",
]);
const agentSourceJsToTsPlugin = {
  name: "lifeops-agent-source-js-to-ts",
  enforce: "pre" as const,
  resolveId(source: string, importer?: string) {
    if (optionalCorePluginStubPackages.has(source)) {
      return `${optionalCorePluginStubPrefix}${source}`;
    }
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
        const tsCandidate = `${candidate.slice(0, -".js".length)}.ts`;
        if (fs.existsSync(tsCandidate)) {
          return tsCandidate;
        }
      }
    }

    return null;
  },
  load(id: string) {
    if (!id.startsWith(optionalCorePluginStubPrefix)) return null;
    const packageName = id.slice(optionalCorePluginStubPrefix.length);
    const name = `${packageName.slice("@elizaos/".length)}-test-stub`;
    return [
      `const plugin = ${JSON.stringify({
        name,
        description: `Test stub for ${packageName}`,
        actions: [],
        providers: [],
        evaluators: [],
        services: [],
      })};`,
      "export { plugin };",
      "export default plugin;",
    ].join("\n");
  },
};
function resolveNodePackageRoot(packageName: string): string {
  const directCandidates = [
    path.join(elizaRoot, "node_modules", packageName),
    path.join(repoRoot, "node_modules", packageName),
    path.join(here, "node_modules", packageName),
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
// Bun's isolated install puts the logger's transitive deps deep under
// `node_modules/.bun/...`. Vite's default resolver, walking up from the
// (realpath of) `packages/logger/src/logger.ts`, sees the local
// `packages/logger/node_modules/<dep>` symlink — but after `preserveSymlinks:
// false` it resolves to a path that Vite then re-walks for nested deps and
// loses the chain on Windows. Anchor adze/fast-redact explicitly to their
// real install dirs so resolution is one hop on every platform.
const adzeRoot = resolveNodePackageRoot("adze");
const fastRedactRoot = resolveNodePackageRoot("fast-redact");
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
// The tri-modal spatial view framework (`@elizaos/ui/spatial`) is browser-safe
// and self-contained; the LifeOps spatial-view test needs the REAL renderer
// (not the `@elizaos/ui` stub) to exercise the GUI/XR/TUI surfaces. Anchor those
// two subpaths to source ahead of the broad `@elizaos/ui/(.+)` stub alias below.
const uiSpatialSrc = path.join(
  elizaRoot,
  "packages",
  "ui",
  "src",
  "spatial",
  "index.ts",
);
const uiSpatialTuiSrc = path.join(
  elizaRoot,
  "packages",
  "ui",
  "src",
  "spatial",
  "tui",
  "index.ts",
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
      {
        find: /^@elizaos\/app-core\/platform\/native-library-policy$/,
        replacement: appCoreNativeLibraryPolicy,
      },
      {
        find: /^@elizaos\/app-core\/services\/task-host-capabilities$/,
        replacement: appCoreTaskHostCapabilities,
      },
      {
        find: /^@elizaos\/core\/node$/,
        replacement: path.join(
          elizaRoot,
          "packages",
          "core",
          "src",
          "index.node.ts",
        ),
      },
      {
        find: /^@elizaos\/tui$/,
        replacement: path.join(elizaRoot, "packages", "tui", "src", "index.ts"),
      },
      {
        find: /^@elizaos\/vault$/,
        replacement: path.join(
          elizaRoot,
          "packages",
          "vault",
          "src",
          "index.ts",
        ),
      },
      // These packages are imported by @elizaos/core while this suite inlines
      // core. Resolve them through Bun's real package-store path so their own
      // nested dependencies remain visible with preserveSymlinks enabled.
      {
        find: /^adze$/,
        replacement: path.join(adzeRoot, "dist", "index.js"),
      },
      {
        find: /^adze\/(.*)$/,
        replacement: path.join(adzeRoot, "$1"),
      },
      {
        find: /^fast-redact$/,
        replacement: path.join(fastRedactRoot, "index.js"),
      },
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
      // Real spatial renderer for the tri-modal view test. These must precede
      // the broad `@elizaos/ui/(.+)` stub alias so they win the match.
      { find: /^@elizaos\/ui\/spatial\/tui$/, replacement: uiSpatialTuiSrc },
      { find: /^@elizaos\/ui\/spatial$/, replacement: uiSpatialSrc },
      {
        find: /^@elizaos\/ui\/(.+)$/,
        replacement: path.join(lifeopsTestStubsRoot, "ui.ts"),
      },
      {
        find: "@elizaos/ui",
        replacement: path.join(lifeopsTestStubsRoot, "ui.ts"),
      },
      // `@elizaos/plugin-calendar`'s built dist pulls `renderGroundedActionReply`
      // from the `@elizaos/agent/actions/grounded-action-reply` subpath (to dodge
      // the full agent barrel in the Plugin Tests lane). The bare-specifier alias
      // below prefix-matches that subpath and rewrites it to `agent.ts/actions/...`,
      // which is unresolvable — so anchor the subpath to the stub explicitly first.
      // Other agent subpaths (e.g. services/app-session-gate) must keep resolving
      // to the real source, so this stays narrow rather than a `/(.+)` catch-all.
      {
        find: /^@elizaos\/agent\/actions\/grounded-action-reply$/,
        replacement: path.join(lifeopsTestStubsRoot, "agent.ts"),
      },
      {
        find: /^@elizaos\/agent\/security\/access$/,
        replacement: path.join(agentSourceRoot, "security", "access.ts"),
      },
      {
        find: /^@elizaos\/agent\/services\/knowledge-graph\/service$/,
        replacement: path.join(
          agentSourceRoot,
          "services",
          "knowledge-graph",
          "service.ts",
        ),
      },
      {
        find: /^@elizaos\/agent\/config\/config$/,
        replacement: path.join(agentSourceRoot, "config", "config.ts"),
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
        find: /^@elizaos\/plugin-calendar\/(.+)$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-calendar",
          "src",
          "$1.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-calendar$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-calendar",
          "src",
          "index.ts",
        ),
      },
      // Lifeops decomposition: plugin-inbox / plugin-blocker are carved deps that
      // are NOT in build:core, so their unbuilt dist can't satisfy the subpath +
      // barrel imports plugin-personal-assistant pulls from them (vitest has no
      // eliza-source condition; bare resolution falls through to missing dist).
      // Anchor both to source (mirrors the plugin-workflow alias above). Subpath
      // rules must precede the barrels so deeper paths match first.
      {
        find: /^@elizaos\/plugin-inbox\/(.+)$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-inbox",
          "src",
          "$1.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-inbox$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-inbox",
          "src",
          "index.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-blocker\/(.+)$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-blocker",
          "src",
          "$1.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-blocker$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-blocker",
          "src",
          "index.ts",
        ),
      },
      // Further lifeops carves p-a imports as bare barrels AND deep subpaths
      // (data-layer plugins not in build:core, no eliza-source condition) — the
      // package `exports` map only sends subpaths to ./src under the eliza-source
      // condition, so without dist they resolve to missing ./dist/*.js. Anchor
      // both the barrel and every subpath to source, same as plugin-blocker.
      {
        find: /^@elizaos\/plugin-finances\/(.+)$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-finances",
          "src",
          "$1.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-finances$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-finances",
          "src",
          "index.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-goals\/(.+)$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-goals",
          "src",
          "$1.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-goals$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-goals",
          "src",
          "index.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-reminders$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-reminders",
          "src",
          "index.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-remote-desktop$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-remote-desktop",
          "src",
          "index.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-scheduling$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-scheduling",
          "src",
          "index.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-whatsapp$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-whatsapp",
          "src",
          "index.ts",
        ),
      },
      // The scenario-corpus gate (test/executive-assistant-scenarios.test.ts)
      // imports the real scenario loader from source; loader.ts references its
      // own package via `@elizaos/scenario-runner/schema`, a self-referencing
      // package-exports import Vite's resolver does not support. Anchor the
      // subpath to the prebuilt schema entry the exports map points at.
      {
        find: /^@elizaos\/scenario-runner\/schema$/,
        replacement: path.join(
          elizaRoot,
          "packages",
          "scenario-runner",
          "schema",
          "index.js",
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
        find: /^@elizaos\/plugin-browser\/password-manager-bridge$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-browser",
          "src",
          "password-manager-bridge.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-x\/lifeops-message-adapter$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-x",
          "src",
          "lifeops-message-adapter.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-phone\/twilio$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-phone",
          "src",
          "twilio.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-elizacloud\/cloud\/(.+)$/,
        replacement: path.join(
          elizaRoot,
          "plugins",
          "plugin-elizacloud",
          "src",
          "cloud",
          "$1.ts",
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
        // service-mixin-discord imports the browser-scraper helpers from the
        // `/user-account-scraper` subpath; discord isn't in build:core so there
        // is no dist, and the bare alias below only catches the barrel. Point the
        // subpath at the same stub (it exports probeDiscordTab et al.) so the
        // suite never pulls the real browser-automation module.
        find: /^@elizaos\/plugin-discord\/user-account-scraper$/,
        replacement: path.join(lifeopsTestStubsRoot, "plugin-discord.ts"),
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
