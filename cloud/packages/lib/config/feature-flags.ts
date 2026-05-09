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

const parseEnvFlag = (envVar: string | undefined, defaultValue: boolean): boolean => {
  if (envVar === undefined) return defaultValue;
  return envVar === "true" || envVar === "1";
};

export const FEATURE_FLAGS: FeatureFlagsMap = {
  mcp: {
    enabled: parseEnvFlag(process.env.NEXT_PUBLIC_FEATURE_MCP, true),
    name: "MCP Integration",
    description: "Model Context Protocol integration and management",
  },
  containers: {
    enabled: parseEnvFlag(process.env.NEXT_PUBLIC_FEATURE_CONTAINERS, true),
    name: "Serverless Containers",
    description: "Container management and serverless deployment",
  },
  gallery: {
    enabled: parseEnvFlag(process.env.NEXT_PUBLIC_FEATURE_GALLERY, true),
    name: "Agent Gallery",
    description: "Public gallery of community agents",
  },
  memories: {
    enabled: parseEnvFlag(process.env.NEXT_PUBLIC_FEATURE_MEMORIES, true),
    name: "Memories & Knowledge",
    description: "Agent memories and knowledge base management",
  },
  voiceCloning: {
    enabled: parseEnvFlag(process.env.NEXT_PUBLIC_FEATURE_VOICE_CLONING, true),
    name: "Voice Cloning",
    description: "Custom voice synthesis and cloning",
  },
  billing: {
    enabled: parseEnvFlag(process.env.NEXT_PUBLIC_FEATURE_BILLING, true),
    name: "Billing & Credits",
    description: "Credit purchases and billing management",
  },
} as const;

export function isFeatureEnabled(flag: FeatureFlag): boolean {
  return FEATURE_FLAGS[flag].enabled;
}

export function getEnabledFeatures(): FeatureFlag[] {
  return (Object.keys(FEATURE_FLAGS) as FeatureFlag[]).filter((key) => FEATURE_FLAGS[key].enabled);
}

export function getDisabledFeatures(): FeatureFlag[] {
  return (Object.keys(FEATURE_FLAGS) as FeatureFlag[]).filter((key) => !FEATURE_FLAGS[key].enabled);
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
      if (!FEATURE_FLAGS[flag as FeatureFlag].enabled) {
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
