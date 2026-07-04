/**
 * Network-fetch layer for the plugin/app marketplace registry. Loads the
 * registry from the cloud over HTTP, preferring the richer generated registry
 * over the flat index registry, and normalizes each entry into a
 * `RegistryPluginInfo` map (including app metadata). Both fetches race under a
 * single short timeout and are gated by a cloud-reachability probe; any network
 * absence, 404, or timeout is treated as an expected fallback
 * (`RegistryNetworkFallbackError`) so the caller can fall back to a local
 * snapshot. Every attempt runs inside a marketplace telemetry span, and callers
 * supply the local-workspace / node-module overlay hooks that merge on-disk
 * plugins into the result.
 */
import { isCloudReachable } from "@elizaos/shared";
import { createIntegrationTelemetrySpan } from "../diagnostics/integration-observability.ts";
import type { RegistryPluginInfo } from "./registry-client-types.ts";

const REGISTRY_FETCH_TIMEOUT_MS = 2_500;

export class RegistryNetworkFallbackError extends Error {
  readonly expectedLocalFallback = true;

  constructor(message: string) {
    super(message);
    this.name = "RegistryNetworkFallbackError";
  }
}

export function isExpectedRegistryNetworkFallback(
  error: unknown,
): error is RegistryNetworkFallbackError {
  return (
    error instanceof RegistryNetworkFallbackError ||
    (error instanceof Error &&
      (error.name === "AbortError" ||
        error.name === "TimeoutError" ||
        error.message.toLowerCase().includes("timeout") ||
        error.message.toLowerCase().includes("timed out"))) ||
    (typeof error === "object" &&
      error !== null &&
      "expectedLocalFallback" in error &&
      (error as { expectedLocalFallback?: unknown }).expectedLocalFallback ===
        true)
  );
}

function isExpectedRegistryNotFound(resp: Response): boolean {
  return resp.status === 404;
}

function createRegistryFetchInit(): RequestInit {
  return {
    redirect: "error",
    signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
  };
}

interface FetchFromNetworkParams {
  generatedRegistryUrl: string;
  indexRegistryUrl: string;
  applyLocalWorkspaceApps: (
    plugins: Map<string, RegistryPluginInfo>,
  ) => Promise<void>;
  applyNodeModulePlugins: (
    plugins: Map<string, RegistryPluginInfo>,
  ) => Promise<void>;
  sanitizeSandbox: (value?: string) => string;
}

/**
 * Fetch + parse the generated registry. Returns the parsed plugin map on a
 * 200, or `null` when the endpoint is absent (404) or the request fails — in
 * which case the caller falls through to the index registry.
 */
async function fetchGeneratedRegistry(
  params: FetchFromNetworkParams,
): Promise<Map<string, RegistryPluginInfo> | null> {
  const {
    generatedRegistryUrl,
    applyLocalWorkspaceApps,
    applyNodeModulePlugins,
    sanitizeSandbox,
  } = params;

  const generatedSpan = createIntegrationTelemetrySpan({
    boundary: "marketplace",
    operation: "fetch_generated_registry",
    timeoutMs: REGISTRY_FETCH_TIMEOUT_MS,
  });
  try {
    const resp = await fetch(generatedRegistryUrl, createRegistryFetchInit());
    if (resp.ok) {
      const data = (await resp.json()) as {
        registry: Record<
          string,
          {
            git: {
              repo: string;
              v0: { branch: string | null };
              v1: { branch: string | null };
              v2: { branch: string | null };
            };
            npm: {
              repo: string;
              v0: string | null;
              v1: string | null;
              v2: string | null;
            };
            supports: { v0: boolean; v1: boolean; v2: boolean };
            description: string;
            homepage: string | null;
            topics: string[];
            stargazers_count: number;
            language: string;
            origin?: string;
            source?: string;
            support?: string;
            builtIn?: boolean;
            firstParty?: boolean;
            thirdParty?: boolean;
            status?: string;
            kind?: string;
            registryKind?: string;
            directory?: string | null;
            app?: {
              displayName: string;
              category: string;
              launchType: string;
              launchUrl: string | null;
              icon: string | null;
              heroImage?: string | null;
              capabilities: string[];
              minPlayers: number | null;
              maxPlayers: number | null;
              runtimePlugin?: string;
              bridgeExport?: string;
              uiExtension?: {
                detailPanelId: string;
              };
              viewer?: {
                url: string;
                embedParams?: Record<string, string>;
                postMessageAuth?: boolean;
                sandbox?: string;
              };
              session?: {
                mode: "viewer" | "spectate-and-steer" | "external";
                features?: Array<
                  "commands" | "telemetry" | "pause" | "resume" | "suggestions"
                >;
              };
              developerOnly?: boolean;
              visibleInAppStore?: boolean;
              mainTab?: boolean;
              catalogSection?: string;
              featured?: boolean;
              defaultHidden?: boolean;
              scope?: string;
            };
          }
        >;
      };
      const plugins = new Map<string, RegistryPluginInfo>();
      for (const [name, e] of Object.entries(data.registry)) {
        const info: RegistryPluginInfo = {
          name,
          gitRepo: e.git.repo,
          gitUrl: `https://github.com/${e.git.repo}.git`,
          directory: e.directory ?? null,
          description: e.description || "",
          homepage: e.homepage,
          topics: e.topics || [],
          stars: e.stargazers_count || 0,
          language: e.language || "TypeScript",
          npm: {
            package: e.npm.repo,
            v0Version: e.npm.v0,
            v1Version: e.npm.v1,
            v2Version: e.npm.v2,
          },
          git: {
            v0Branch: e.git.v0.branch ?? null,
            v1Branch: e.git.v1.branch ?? null,
            v2Branch: e.git.v2.branch ?? null,
          },
          supports: e.supports,
          origin: e.origin,
          source: e.source,
          support: e.support,
          builtIn: e.builtIn,
          firstParty: e.firstParty,
          thirdParty: e.thirdParty,
          status: e.status,
          registryKind: e.registryKind,
        };

        if (e.kind) {
          info.kind = e.kind;
        }
        if (e.kind === "app" || e.app) {
          info.kind = "app";
        }
        if (e.app) {
          info.appMeta = {
            displayName: e.app.displayName,
            category: e.app.category,
            launchType: e.app.launchType,
            launchUrl: e.app.launchUrl,
            icon: e.app.icon,
            heroImage: e.app.heroImage ?? null,
            capabilities: e.app.capabilities || [],
            minPlayers: e.app.minPlayers ?? null,
            maxPlayers: e.app.maxPlayers ?? null,
            runtimePlugin: e.app.runtimePlugin,
            bridgeExport: e.app.bridgeExport,
            uiExtension: e.app.uiExtension,
            viewer: e.app.viewer
              ? {
                  ...e.app.viewer,
                  sandbox: sanitizeSandbox(e.app.viewer.sandbox),
                }
              : undefined,
            session: e.app.session,
            developerOnly: e.app.developerOnly,
            visibleInAppStore: e.app.visibleInAppStore,
            mainTab: e.app.mainTab,
            catalogSection: e.app.catalogSection,
            featured: e.app.featured,
            defaultHidden: e.app.defaultHidden,
            scope: e.app.scope,
          };
        }

        plugins.set(name, info);
      }
      await applyLocalWorkspaceApps(plugins);
      await applyNodeModulePlugins(plugins);
      generatedSpan.success({ statusCode: resp.status });
      return plugins;
    }
    if (!isExpectedRegistryNotFound(resp)) {
      generatedSpan.failure({
        statusCode: resp.status,
        errorKind: "http_error",
      });
    }
    return null;
  } catch (err) {
    generatedSpan.failure({ error: err });
    // caller logs fallback warnings
    return null;
  }
}

/**
 * Fetch + parse the index registry. Throws `RegistryNetworkFallbackError` (or
 * the raw network error) when it cannot be loaded, signalling the caller to
 * use the local snapshot.
 */
async function fetchIndexRegistry(
  params: FetchFromNetworkParams,
): Promise<Map<string, RegistryPluginInfo>> {
  const { indexRegistryUrl, applyLocalWorkspaceApps, applyNodeModulePlugins } =
    params;

  const indexSpan = createIntegrationTelemetrySpan({
    boundary: "marketplace",
    operation: "fetch_index_registry",
    timeoutMs: REGISTRY_FETCH_TIMEOUT_MS,
  });
  let resp: Response;
  try {
    resp = await fetch(indexRegistryUrl, createRegistryFetchInit());
  } catch (err) {
    indexSpan.failure({ error: err });
    throw err;
  }
  if (!resp.ok) {
    if (!isExpectedRegistryNotFound(resp)) {
      indexSpan.failure({ statusCode: resp.status, errorKind: "http_error" });
    }
    throw new RegistryNetworkFallbackError(
      `index.json: ${resp.status} ${resp.statusText}`,
    );
  }
  const data = (await resp.json()) as Record<string, string>;
  const plugins = new Map<string, RegistryPluginInfo>();
  for (const [name, gitRef] of Object.entries(data)) {
    const repo = gitRef.replace(/^github:/, "");
    const isBuiltIn = name.startsWith("@elizaos/");
    plugins.set(name, {
      name,
      gitRepo: repo,
      gitUrl: `https://github.com/${repo}.git`,
      directory: null,
      description: "",
      homepage: null,
      topics: [],
      stars: 0,
      language: "TypeScript",
      npm: { package: name, v0Version: null, v1Version: null, v2Version: null },
      git: { v0Branch: null, v1Branch: null, v2Branch: "next" },
      supports: { v0: false, v1: false, v2: false },
      origin: isBuiltIn ? "builtin" : "third-party",
      source: isBuiltIn ? "builtin" : "third-party",
      support: isBuiltIn ? "first-party" : "community",
      builtIn: isBuiltIn,
      firstParty: isBuiltIn,
      thirdParty: !isBuiltIn,
    });
  }
  await applyLocalWorkspaceApps(plugins);
  await applyNodeModulePlugins(plugins);
  indexSpan.success({ statusCode: resp.status });
  return plugins;
}

/**
 * Resolve the plugin registry from the network, preferring the generated
 * registry over the index registry.
 *
 * Both network attempts are issued concurrently so a doomed-offline boot
 * waits out a single ~2.5s timeout instead of two sequential ones. The
 * generated result still wins whenever it loads; the index result is only
 * consulted (and its failure only surfaced) when the generated registry is
 * absent. When the cloud is already known to be unreachable for this boot we
 * skip both fetches entirely and go straight to the local-snapshot fallback.
 */
export async function fetchFromNetwork(
  params: FetchFromNetworkParams,
): Promise<Map<string, RegistryPluginInfo>> {
  if (!(await isCloudReachable())) {
    throw new RegistryNetworkFallbackError(
      "cloud unreachable at boot — using local registry snapshot",
    );
  }

  const generatedResult = fetchGeneratedRegistry(params);
  const indexResult = fetchIndexRegistry(params);
  // Prevent an unhandled rejection if the generated registry wins the race and
  // we never await the index attempt; its failure is only relevant as a
  // fallback when the generated registry is absent.
  indexResult.catch(() => {});

  const generated = await generatedResult;
  if (generated) {
    return generated;
  }
  return indexResult;
}
