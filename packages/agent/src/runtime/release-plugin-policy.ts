import { CORE_PLUGINS, OPTIONAL_CORE_PLUGINS } from "./core-plugins.ts";

const BASELINE_RUNTIME_SUPPORT_PACKAGES = [
  "@elizaos/core",
  "@elizaos/prompts",
  "@elizaos/plugin-remote-manifest",
  "@elizaos/plugin-worker-runtime",
] as const;

const BASELINE_PROVIDER_PLUGINS = [
  "@elizaos/plugin-elizacloud",
  "@elizaos/plugin-openai",
  "@elizaos/plugin-anthropic",
  "@elizaos/plugin-ollama",
] as const;

// Desktop loads this through the legacy "agent-orchestrator" compatibility id,
// but the implementation ships as the scoped package below.
const BASELINE_DESKTOP_RUNTIME_PLUGINS = [
  "@elizaos/plugin-agent-orchestrator",
] as const;

// These are implementation dependencies of bundled core plugins. They need
// to ship in the runtime bundle, but are not auto-loaded by collectPluginNames.
const BASELINE_PLUGIN_SUPPORT_PACKAGES = [
  "@elizaos/plugin-calendly",
  "@elizaos/plugin-health",
  "@elizaos/plugin-app-manager",
  "@elizaos/plugin-registry",
  "@elizaos/plugin-wallet-ui",
  "@elizaos/plugin-wallet",
] as const;

// Plugins excluded from the baseline release that can only be installed on a
// local desktop runtime after release. Desktop and local runtimes share the
// same exclusion list, so a single source of truth drives both flags.
const RUNTIME_ONLY_PLUGINS = new Set<string>([
  "@elizaos/plugin-agent-orchestrator",
  "@elizaos/plugin-browser",
  "@elizaos/plugin-computeruse",
]);

export type RegistryPluginInstallSurface = "runtime" | "app";
export type RegistryPluginReleaseAvailability = "bundled" | "post-release";

export interface RegistryPluginReleaseCompatibility {
  releaseAvailability: RegistryPluginReleaseAvailability;
  installSurface: RegistryPluginInstallSurface;
  postReleaseInstallable: boolean;
  requiresDesktopRuntime: boolean;
  requiresLocalRuntime: boolean;
  note?: string;
}

export const BASELINE_BUNDLED_RUNTIME_PACKAGES: readonly string[] = [
  ...BASELINE_RUNTIME_SUPPORT_PACKAGES,
  ...BASELINE_DESKTOP_RUNTIME_PLUGINS,
  ...CORE_PLUGINS,
  ...OPTIONAL_CORE_PLUGINS,
  ...BASELINE_PLUGIN_SUPPORT_PACKAGES,
  ...BASELINE_PROVIDER_PLUGINS,
];

const BASELINE_REGISTRY_BUNDLED_PLUGIN_PACKAGES: readonly string[] = [
  ...BASELINE_DESKTOP_RUNTIME_PLUGINS,
  ...CORE_PLUGINS,
  ...OPTIONAL_CORE_PLUGINS,
  ...BASELINE_PROVIDER_PLUGINS,
];

export function derivePluginIdFromPackageName(packageName: string): string {
  return packageName
    .replace(/^@[^/]+\/plugin-/, "")
    .replace(/^@[^/]+\//, "")
    .replace(/^plugin-/, "");
}

const BASELINE_REGISTRY_BUNDLED_PLUGIN_IDS = new Set(
  BASELINE_REGISTRY_BUNDLED_PLUGIN_PACKAGES.map(derivePluginIdFromPackageName),
);

export function getBundledRuntimePackages(
  availableDependencies: Iterable<string>,
): string[] {
  const available = new Set(availableDependencies);
  return BASELINE_BUNDLED_RUNTIME_PACKAGES.filter((packageName) =>
    available.has(packageName),
  ).sort();
}

export function getBundledRuntimePluginIds(
  availableDependencies: Iterable<string>,
): string[] {
  const available = new Set(availableDependencies);
  return BASELINE_REGISTRY_BUNDLED_PLUGIN_PACKAGES.filter((packageName) =>
    available.has(packageName),
  )
    .map(derivePluginIdFromPackageName)
    .filter((pluginId) => pluginId.length > 0)
    .sort();
}

export function classifyRegistryPluginRelease(params: {
  packageName: string;
  bundledPluginIds: ReadonlySet<string>;
  kind?: string;
}): RegistryPluginReleaseCompatibility {
  const { packageName, bundledPluginIds, kind } = params;

  if (kind === "app") {
    return {
      releaseAvailability: "post-release",
      installSurface: "app",
      postReleaseInstallable: false,
      requiresDesktopRuntime: false,
      requiresLocalRuntime: false,
      note: "Launchable apps are installed through the app catalog, not the runtime plugin installer.",
    };
  }

  const pluginId = derivePluginIdFromPackageName(packageName);
  const bundled =
    BASELINE_REGISTRY_BUNDLED_PLUGIN_IDS.has(pluginId) &&
    bundledPluginIds.has(pluginId);
  const requiresRuntimeInstall = RUNTIME_ONLY_PLUGINS.has(packageName);

  let note: string;
  if (bundled) {
    note = "Included in the baseline Eliza runtime bundle.";
  } else if (requiresRuntimeInstall) {
    note =
      "Excluded from the baseline release. Install on a local desktop runtime after release.";
  } else {
    note = "Excluded from the baseline release and installable after release.";
  }

  return {
    releaseAvailability: bundled ? "bundled" : "post-release",
    installSurface: "runtime",
    postReleaseInstallable: !bundled,
    requiresDesktopRuntime: requiresRuntimeInstall,
    requiresLocalRuntime: requiresRuntimeInstall,
    note,
  };
}
