/**
 * Resolves scenario-declared plugin packages at the runtime boundary. The
 * provider-qualified profile accepts only installable production packages and
 * registers them before runtime initialization; simulated runs retain the
 * small compatibility wrapper needed by existing app-control fixtures.
 *
 * Package import specifiers and scenario-local fixture plugin names are
 * declared separately. Packages are imported here before runtime startup;
 * fixture names are verified by the executor after the scenario seed runs.
 */

import {
  type Action,
  type AgentRuntime,
  ElizaError,
  type Plugin,
} from "@elizaos/core";
import type {
  ScenarioDefinition,
  ScenarioExecutionProfile,
} from "@elizaos/scenario-runner/schema";

const MEETINGS_PLUGIN_PACKAGE = "@elizaos/plugin-meetings";
const MEETINGS_TEST_SUPPORT_PACKAGE = "@elizaos/plugin-meetings/test-support";

const NON_PRODUCTION_PACKAGE_PATTERN =
  /(?:^|[/._-])(?:mock|mocks|fixture|fixtures|test|tests|test-harness)(?:$|[/._-])/iu;
const PACKAGE_NAME_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?:\/(?!\.{1,2}(?:\/|$))[^/\\\s]+)*$/iu;

export function assertScenarioPluginPackageSpecifier(
  packageName: string,
): void {
  if (PACKAGE_NAME_PATTERN.test(packageName)) return;
  throw new ElizaError(
    `Scenario plugin package "${packageName}" is not a supported npm import specifier`,
    {
      code: "SCENARIO_PLUGIN_PACKAGE_SPECIFIER_INVALID",
      context: { packageName },
    },
  );
}

function isPlugin(value: unknown): value is Plugin {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.name !== "string" || obj.name.trim().length === 0) {
    return false;
  }
  return (
    Array.isArray(obj.actions) ||
    Array.isArray(obj.providers) ||
    Array.isArray(obj.services) ||
    Array.isArray(obj.evaluators) ||
    Array.isArray(obj.routes) ||
    typeof obj.init === "function" ||
    (obj.models !== null && typeof obj.models === "object")
  );
}

export function resolveRequiredPluginPackages(
  scenario: ScenarioDefinition,
): string[] {
  const plugins = scenario.requires?.plugins;
  if (!Array.isArray(plugins)) return [];
  const normalized = plugins.map((plugin) => plugin.trim()).filter(Boolean);
  for (const packageName of normalized) {
    assertScenarioPluginPackageSpecifier(packageName);
  }
  return [...new Set(normalized)];
}

export function resolveRequiredFixturePlugins(
  scenario: ScenarioDefinition,
): string[] {
  const plugins = scenario.requires?.fixturePlugins;
  if (!Array.isArray(plugins)) return [];
  const normalized = plugins.map((plugin) => plugin.trim()).filter(Boolean);
  return [...new Set(normalized)];
}

/**
 * Reject shared-runtime batches where a test companion would alter a production
 * scenario that did not declare it. Process-isolated execution remains valid.
 */
export function assertSharedRuntimePluginBatchSafe(
  scenarios: readonly ScenarioDefinition[],
): void {
  const meetingScenarios = scenarios.map((scenario) => ({
    id: scenario.id,
    plugins: resolveRequiredPluginPackages(scenario),
  }));
  const withTestSupport = meetingScenarios.filter(({ plugins }) =>
    plugins.includes(MEETINGS_TEST_SUPPORT_PACKAGE),
  );
  for (const scenario of withTestSupport) {
    if (!scenario.plugins.includes(MEETINGS_PLUGIN_PACKAGE)) {
      throw new Error(
        `[scenario-runner] scenario ${scenario.id} declares meetings test support without ${MEETINGS_PLUGIN_PACKAGE}`,
      );
    }
  }
  if (withTestSupport.length === 0) return;
  const withoutTestSupport = meetingScenarios.filter(
    ({ plugins }) => !plugins.includes(MEETINGS_TEST_SUPPORT_PACKAGE),
  );
  if (withoutTestSupport.length > 0) {
    throw new Error(
      `[scenario-runner] unsafe shared meetings batch: once test support is loaded by [${withTestSupport.map(({ id }) => id).join(", ")}], every scenario sharing that runtime must explicitly declare ${MEETINGS_TEST_SUPPORT_PACKAGE}; missing declarations: [${withoutTestSupport.map(({ id }) => id).join(", ")}]. Run those scenarios process-isolated or select a dependency-homogeneous batch`,
    );
  }
}

export function providerQualifiedPluginPackageProblem(
  packageName: string,
): string | null {
  if (!PACKAGE_NAME_PATTERN.test(packageName)) {
    return `required plugin "${packageName}" is not a supported npm import specifier`;
  }
  if (NON_PRODUCTION_PACKAGE_PATTERN.test(packageName)) {
    return `required plugin "${packageName}" names a test, mock, or fixture package`;
  }
  return null;
}

export function assertProviderQualifiedPluginPackages(
  packageNames: readonly string[],
): void {
  if (packageNames.length === 0) {
    throw new Error(
      "[scenario-runner] provider-qualified execution requires a non-empty scenario-declared production plugin set",
    );
  }
  const problems = packageNames
    .map(providerQualifiedPluginPackageProblem)
    .filter((problem): problem is string => problem !== null);
  if (problems.length > 0) {
    throw new Error(
      `[scenario-runner] provider-qualified plugin preflight failed: ${problems.join("; ")}`,
    );
  }
}

function pluginNameAliases(packageName: string): Set<string> {
  const withoutScope = packageName.replace(/^@elizaos\//u, "");
  const withoutPluginPrefix = withoutScope.replace(/^plugin-/u, "");
  return new Set([
    packageName,
    withoutScope,
    withoutPluginPrefix,
    `plugin-${withoutPluginPrefix}`,
  ]);
}

/**
 * Whether one registered plugin is the one a scenario declared as
 * `packageName`. A plugin's internal `name` routinely differs from its package
 * specifier, so this alias comparison is the only correct identity test and
 * every caller must share it.
 */
export function pluginMatchesScenarioPackage(
  plugin: Pick<Plugin, "name">,
  packageName: string,
): boolean {
  if (typeof plugin.name !== "string") return false;
  return pluginNameAliases(packageName).has(plugin.name.trim());
}

export function pluginPackageIsRegistered(
  runtime: Pick<AgentRuntime, "plugins">,
  packageName: string,
): boolean {
  return runtime.plugins.some((plugin) =>
    pluginMatchesScenarioPackage(plugin, packageName),
  );
}

async function loadSimulatedAppControlPlugin(): Promise<Plugin | null> {
  const mod = (await import("@elizaos/plugin-app-control")) as {
    appAction?: Action;
    appControlPlugin?: Plugin;
    backgroundAction?: Action;
    viewsAction?: Action;
    settingsAction?: Action;
  };
  if (
    !mod.appAction ||
    !mod.backgroundAction ||
    !mod.viewsAction ||
    !mod.settingsAction
  ) {
    return null;
  }
  return {
    name: "app-control",
    description: "App control simulated-scenario actions.",
    actions: [
      mod.appAction,
      mod.backgroundAction,
      mod.viewsAction,
      mod.settingsAction,
    ],
    responseHandlerEvaluators: mod.appControlPlugin?.responseHandlerEvaluators,
  };
}

export async function loadScenarioRequiredPlugin(
  packageName: string,
  executionProfile: ScenarioExecutionProfile,
): Promise<Plugin | null> {
  if (
    executionProfile === "simulated" &&
    packageName === "@elizaos/plugin-app-control"
  ) {
    return loadSimulatedAppControlPlugin();
  }
  if (executionProfile === "provider-qualified") {
    assertProviderQualifiedPluginPackages([packageName]);
  }

  const mod = (await import(packageName)) as Record<string, unknown>;
  const candidate =
    [mod.default, mod.elizaPlugin, mod.plugin, mod.schedulingPlugin].find(
      isPlugin,
    ) ?? Object.values(mod).find(isPlugin);
  if (!candidate) return null;
  if (
    executionProfile === "provider-qualified" &&
    NON_PRODUCTION_PACKAGE_PATTERN.test(candidate.name)
  ) {
    throw new Error(
      `[scenario-runner] provider-qualified plugin "${packageName}" resolved to non-production plugin name "${candidate.name}"`,
    );
  }
  return candidate;
}

/**
 * Registers every declared package once before scenario runtime startup and
 * returns the names that are registered afterwards. Fixture plugin names are
 * a separate declaration and never reach this import boundary.
 */
export async function registerScenarioRequiredPlugins(
  runtime: Pick<AgentRuntime, "plugins" | "registerPlugin">,
  packageNames: readonly string[],
  executionProfile: ScenarioExecutionProfile,
): Promise<string[]> {
  const registered: string[] = [];
  for (const packageName of packageNames) {
    assertScenarioPluginPackageSpecifier(packageName);
    if (!pluginPackageIsRegistered(runtime, packageName)) {
      const plugin = await loadScenarioRequiredPlugin(
        packageName,
        executionProfile,
      );
      if (!plugin) {
        throw new Error(
          `[scenario-runner] required package ${packageName} did not export a Plugin`,
        );
      }
      await runtime.registerPlugin(plugin);
    }
    registered.push(packageName);
  }
  return registered;
}
