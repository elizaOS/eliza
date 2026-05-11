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

export async function fetchFromNetwork(params: {
  generatedRegistryUrl: string;
  indexRegistryUrl: string;
  applyLocalWorkspaceApps: (
    plugins: Map<string, RegistryPluginInfo>,
  ) => Promise<void>;
  applyNodeModulePlugins: (
    plugins: Map<string, RegistryPluginInfo>,
  ) => Promise<void>;
  sanitizeSandbox: (value?: string) => string;
}): Promise<Map<string, RegistryPluginInfo>> {
  const {
    generatedRegistryUrl,
    indexRegistryUrl,
    applyLocalWorkspaceApps,
    applyNodeModulePlugins,
    sanitizeSandbox,
  } = params;

  const generatedSpan = createIntegrationTelemetrySpan({
    boundary: "marketplace",
    operation: "fetch_generated_registry",
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
            v0Branch: e.git.v0?.branch ?? null,
            v1Branch: e.git.v1?.branch ?? null,
            v2Branch: e.git.v2?.branch ?? null,
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
  } catch (err) {
    generatedSpan.failure({ error: err });
    // caller logs fallback warnings
  }

  const indexSpan = createIntegrationTelemetrySpan({
    boundary: "marketplace",
    operation: "fetch_index_registry",
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
