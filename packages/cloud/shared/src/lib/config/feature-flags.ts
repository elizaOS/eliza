// Defines cloud configuration feature flags invariants for backend services.
import { getCloudAwareEnv } from "../runtime/cloud-bindings";

export type FeatureFlag =
  | "mcp"
  | "containers"
  | "gallery"
  | "memories"
  | "voiceCloning"
  | "billing";

export interface FeatureFlagConfig {
  enabled: boolean;
  name: string;
  description: string;
}

type FeatureFlagsMap = Record<FeatureFlag, FeatureFlagConfig>;

export const FEATURE_FLAGS: FeatureFlagsMap = {
  mcp: {
    enabled: true,
    name: "MCP Integration",
    description: "Model Context Protocol integration and management",
  },
  containers: {
    enabled: true,
    name: "Serverless Containers",
    description: "Container management and serverless deployment",
  },
  gallery: {
    enabled: true,
    name: "Agent Gallery",
    description: "Public gallery of community agents",
  },
  memories: {
    enabled: true,
    name: "Memories & Knowledge",
    description: "Agent memories and knowledge base management",
  },
  voiceCloning: {
    enabled: true,
    name: "Voice Cloning",
    description: "Custom voice synthesis and cloning",
  },
  billing: {
    enabled: true,
    name: "Billing & Credits",
    description: "Credit purchases and billing management",
  },
} as const;

function parseFlagList(raw: string | undefined): Set<string> {
  if (!raw) {
    return new Set();
  }
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

/**
 * Resolve a flag, letting runtime env override the compiled default so a
 * feature can be killed (or force-enabled) mid-incident without a deploy:
 *   FEATURE_FLAGS_DISABLED="mcp,billing"  -> force off (kill switch)
 *   FEATURE_FLAGS_ENABLED="gallery"       -> force on
 * Disable wins over enable so the kill switch is always authoritative.
 */
export function isFeatureEnabled(flag: FeatureFlag): boolean {
  const env = getCloudAwareEnv();
  if (parseFlagList(env.FEATURE_FLAGS_DISABLED).has(flag)) {
    return false;
  }
  if (parseFlagList(env.FEATURE_FLAGS_ENABLED).has(flag)) {
    return true;
  }
  return FEATURE_FLAGS[flag].enabled;
}

export function getEnabledFeatures(): FeatureFlag[] {
  return (Object.keys(FEATURE_FLAGS) as FeatureFlag[]).filter(isFeatureEnabled);
}

export function getDisabledFeatures(): FeatureFlag[] {
  return (Object.keys(FEATURE_FLAGS) as FeatureFlag[]).filter((key) => !isFeatureEnabled(key));
}

export const FEATURE_ROUTE_MAP: Record<FeatureFlag, { frontend: string[]; api: string[] }> = {
  mcp: {
    frontend: ["/dashboard/mcps"],
    api: ["/api/mcp", "/api/v1/mcp"],
  },
  containers: {
    frontend: ["/dashboard/containers"],
    api: ["/api/v1/containers"],
  },
  gallery: {
    frontend: ["/dashboard/gallery"],
    api: ["/api/v1/gallery"],
  },
  memories: {
    frontend: ["/dashboard/documents"],
    api: ["/api/v1/documents", "/api/v1/memories"],
  },
  voiceCloning: {
    frontend: ["/dashboard/voices"],
    api: ["/api/v1/voices"],
  },
  billing: {
    frontend: ["/dashboard/billing"],
    api: ["/api/billing"],
  },
};

export function isRouteEnabled(pathname: string): boolean {
  for (const [flag, routes] of Object.entries(FEATURE_ROUTE_MAP)) {
    const allRoutes = [...routes.frontend, ...routes.api];
    if (allRoutes.some((route) => pathname.startsWith(route))) {
      if (!isFeatureEnabled(flag as FeatureFlag)) {
        return false;
      }
    }
  }
  return true;
}

export function getFeatureForRoute(pathname: string): FeatureFlag | null {
  for (const [flag, routes] of Object.entries(FEATURE_ROUTE_MAP)) {
    const allRoutes = [...routes.frontend, ...routes.api];
    if (allRoutes.some((route) => pathname.startsWith(route))) {
      return flag as FeatureFlag;
    }
  }
  return null;
}

// Steward wallet migration flags live in wallet-provider-flags.ts
