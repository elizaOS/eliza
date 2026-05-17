import { CORE_PLUGINS, OPTIONAL_CORE_PLUGINS } from "./core-plugins.ts";

const BASELINE_RUNTIME_SUPPORT_PACKAGES = [
  "@elizaos/core",
  "@elizaos/prompts",
] as const;

const BASELINE_PROVIDER_PLUGINS = [
  "@elizaos/plugin-elizacloud",
  "@elizaos/plugin-openai",
  "@elizaos/plugin-anthropic",
  "@elizaos/plugin-ollama",
] as const;

const DESKTOP_RUNTIME_ONLY_PLUGINS = new Set<string>([
  "@elizaos/plugin-browser",
  "@elizaos/plugin-computeruse",
]);

const LOCAL_RUNTIME_ONLY_PLUGINS = new Set<string>([
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
  return getBundledRuntimePackages(availableDependencies)
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
  const bundled = bundledPluginIds.has(pluginId);
  const requiresDesktopRuntime = DESKTOP_RUNTIME_ONLY_PLUGINS.has(packageName);
  const requiresLocalRuntime = LOCAL_RUNTIME_ONLY_PLUGINS.has(packageName);

  let note: string | undefined;
  if (bundled) {
    note = "Included in the baseline Eliza runtime bundle.";
  } else if (requiresDesktopRuntime && requiresLocalRuntime) {
    note =
      "Excluded from the baseline release. Install on a local desktop runtime after release.";
  } else if (requiresDesktopRuntime) {
    note =
      "Excluded from the baseline release. Install on desktop targets after release.";
  } else if (requiresLocalRuntime) {
    note =
      "Excluded from the baseline release. Install on a local runtime after release.";
  } else {
    note = "Excluded from the baseline release and installable after release.";
  }

  return {
    releaseAvailability: bundled ? "bundled" : "post-release",
    installSurface: "runtime",
    postReleaseInstallable: !bundled,
    requiresDesktopRuntime,
    requiresLocalRuntime,
    note,
  };
}
