import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { repoRoot } from "../../test/vitest/repo-root";
import { getElizaWorkspaceRoot } from "../../test/vitest/workspace-aliases";
import baseConfig from "./vitest.config";

const here = path.dirname(fileURLToPath(import.meta.url));
const elizaRoot = getElizaWorkspaceRoot(repoRoot);
const packageRootFromRepo = path
  .relative(elizaRoot, here)
  .split(path.sep)
  .join("/");

const e2eAndRealIncludes = [
  `${packageRootFromRepo}/src/**/*.e2e.test.{ts,tsx}`,
  `${packageRootFromRepo}/src/**/*.real.test.{ts,tsx}`,
  `${packageRootFromRepo}/src/**/*.real.e2e.test.{ts,tsx}`,
  `${packageRootFromRepo}/test/**/*.e2e.test.{ts,tsx}`,
  `${packageRootFromRepo}/test/**/*.real.test.{ts,tsx}`,
  `${packageRootFromRepo}/test/**/*.real.e2e.test.{ts,tsx}`,
];

const lifeopsTestStubsRoot = path.join(here, "test", "stubs");
const lifeopsTestSetup = path.join(here, "test", "setup.ts");
const agentSourceRoot = path.join(elizaRoot, "packages", "agent", "src");
const lifeopsSourceRoot = path.join(here, "src");
const virtualAgentStubId = "\0lifeops-background-real-agent-stub";
const lifeopsJsEntrypoints = new Map([
  [
    path.join(lifeopsSourceRoot, "actions", "scheduling.js"),
    path.join(lifeopsSourceRoot, "actions", "lib", "scheduling-handler.ts"),
  ],
]);

function stripFsPrefix(value: string): string {
  return value.replace(/^\/@fs/, "");
}

function resolveJsToTsFromSourceRoot(
  sourceRoot: string,
  source: string,
  importer?: string,
): string | null {
  const normalizedImporter = importer ? stripFsPrefix(importer) : undefined;
  if (
    !normalizedImporter ||
    (!source.startsWith("./") && !source.startsWith("../")) ||
    !source.endsWith(".js")
  ) {
    return null;
  }

  const candidate = path.resolve(path.dirname(normalizedImporter), source);
  const entrypoint = lifeopsJsEntrypoints.get(candidate);
  if (entrypoint && fs.existsSync(entrypoint)) {
    return entrypoint;
  }

  if (!candidate.startsWith(`${sourceRoot}${path.sep}`)) {
    return null;
  }

  const tsCandidate = candidate.slice(0, -".js".length) + ".ts";
  return fs.existsSync(tsCandidate) ? tsCandidate : null;
}

const backgroundRealResolvePlugin = {
  name: "lifeops-background-real-resolve",
  enforce: "pre" as const,
  resolveId(source: string, importer?: string) {
    if (source === "@elizaos/agent") {
      return virtualAgentStubId;
    }

    return (
      resolveJsToTsFromSourceRoot(lifeopsSourceRoot, source, importer) ??
      resolveJsToTsFromSourceRoot(agentSourceRoot, source, importer)
    );
  },
  load(id: string) {
    if (id !== virtualAgentStubId) {
      return null;
    }

    const agentStubPath = path
      .join(lifeopsTestStubsRoot, "agent.ts")
      .split(path.sep)
      .join("/");
    return `
export * from "${agentStubPath}";
export function loadOwnerContactsConfig() {
  return {};
}
export async function loadOwnerContactRoutingHints() {
  return {};
}
export function resolveOwnerContactWithFallback() {
  return null;
}
`;
  },
};

const plugins = [
  backgroundRealResolvePlugin,
  ...(Array.isArray(baseConfig.plugins)
    ? baseConfig.plugins.filter(
        (plugin) =>
          !plugin ||
          typeof plugin !== "object" ||
          plugin.name !== "lifeops-agent-source-js-to-ts",
      )
    : []),
];

const aliases = Array.isArray(baseConfig.resolve?.alias)
  ? baseConfig.resolve.alias.filter(
      (alias) =>
        !(
          alias &&
          typeof alias === "object" &&
          "find" in alias &&
          alias.find === "@elizaos/agent"
        ),
    )
  : baseConfig.resolve?.alias;

const setupFiles = Array.isArray(baseConfig.test?.setupFiles)
  ? baseConfig.test.setupFiles.filter(
      (setupFile) => setupFile !== lifeopsTestSetup,
    )
  : baseConfig.test?.setupFiles;

export default defineConfig({
  ...baseConfig,
  plugins,
  resolve: {
    ...baseConfig.resolve,
    alias: aliases,
  },
  test: {
    ...baseConfig.test,
    include: e2eAndRealIncludes,
    exclude: ["dist/**", "**/node_modules/**"],
    setupFiles,
    coverage: {
      ...baseConfig.test?.coverage,
      enabled: false,
    },
  },
});
