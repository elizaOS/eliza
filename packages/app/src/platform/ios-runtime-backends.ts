/**
 * Policy table plus selectors that decide which in-process runtime backs the
 * local iOS agent. Enumerates the three candidate backends (`full-bun-engine`,
 * `swift-bun-jscore`, `ittp-jscontext`) with their readiness/capability flags,
 * then resolves a selection from availability plus opt-in flags. The invariant
 * the table and the blocker checks enforce: the agent runtime always stays in
 * the TypeScript bundle and native code is bridge-only, so only the full Bun
 * engine is approved for production / App-Store local-runtime builds — the
 * others are explicitly-enabled compatibility paths surfaced as warnings.
 */
export type IosLocalRuntimeBackendId =
  | "full-bun-engine"
  | "swift-bun-jscore"
  | "ittp-jscontext";

export type IosLocalRuntimeNativeRole = "bridge-only";

export type IosLocalRuntimeOwner = "typescript-agent-bundle";

export type IosLocalRuntimeReadiness =
  | "production"
  | "candidate"
  | "compatibility";

export interface IosLocalRuntimeBackendDefinition {
  id: IosLocalRuntimeBackendId;
  readiness: IosLocalRuntimeReadiness;
  runtimeOwner: IosLocalRuntimeOwner;
  nativeRole: IosLocalRuntimeNativeRole;
  requiresNativeArtifact: boolean;
  runsInIosAppProcess: boolean;
  appStoreAllowed: boolean;
  productionLocalAllowed: boolean;
  supportsAgentBundle: boolean;
  supportsHttpRequestBridge: boolean;
  supportsSendMessage: boolean;
  supportsNativeLlamaHostCalls: boolean;
  supportsCodingAgentsInApp: false;
  supportsDynamicNativeCode: false;
}

export interface IosLocalRuntimeBackendSelectionInput {
  fullBunEngineAvailable: boolean;
  swiftBunJscoreAvailable?: boolean;
  allowSwiftBunCandidate?: boolean;
  allowIttpCompatibilityFallback?: boolean;
  requireProductionSafe?: boolean;
}

export interface IosLocalRuntimeBackendSelection {
  backend: IosLocalRuntimeBackendId | null;
  definition: IosLocalRuntimeBackendDefinition | null;
  reason: string;
  warnings: string[];
}

export const IOS_LOCAL_RUNTIME_BACKENDS = [
  {
    id: "full-bun-engine",
    readiness: "production",
    runtimeOwner: "typescript-agent-bundle",
    nativeRole: "bridge-only",
    requiresNativeArtifact: true,
    runsInIosAppProcess: true,
    appStoreAllowed: true,
    productionLocalAllowed: true,
    supportsAgentBundle: true,
    supportsHttpRequestBridge: true,
    supportsSendMessage: true,
    supportsNativeLlamaHostCalls: true,
    supportsCodingAgentsInApp: false,
    supportsDynamicNativeCode: false,
  },
  {
    id: "swift-bun-jscore",
    readiness: "candidate",
    runtimeOwner: "typescript-agent-bundle",
    nativeRole: "bridge-only",
    requiresNativeArtifact: true,
    runsInIosAppProcess: true,
    appStoreAllowed: false,
    productionLocalAllowed: false,
    supportsAgentBundle: false,
    supportsHttpRequestBridge: true,
    supportsSendMessage: true,
    supportsNativeLlamaHostCalls: false,
    supportsCodingAgentsInApp: false,
    supportsDynamicNativeCode: false,
  },
  {
    id: "ittp-jscontext",
    readiness: "compatibility",
    runtimeOwner: "typescript-agent-bundle",
    nativeRole: "bridge-only",
    requiresNativeArtifact: false,
    runsInIosAppProcess: true,
    appStoreAllowed: false,
    productionLocalAllowed: false,
    supportsAgentBundle: false,
    supportsHttpRequestBridge: true,
    supportsSendMessage: true,
    supportsNativeLlamaHostCalls: false,
    supportsCodingAgentsInApp: false,
    supportsDynamicNativeCode: false,
  },
] as const satisfies readonly IosLocalRuntimeBackendDefinition[];

export function getIosLocalRuntimeBackendDefinition(
  id: IosLocalRuntimeBackendId,
): IosLocalRuntimeBackendDefinition {
  const definition = IOS_LOCAL_RUNTIME_BACKENDS.find(
    (candidate) => candidate.id === id,
  );
  if (!definition) {
    throw new Error(`Unknown iOS local runtime backend: ${id}`);
  }
  return definition;
}

export function getIosLocalRuntimeProductionBlockers(
  id: IosLocalRuntimeBackendId,
): string[] {
  const definition = getIosLocalRuntimeBackendDefinition(id);
  const blockers: string[] = [];
  if (definition.runtimeOwner !== "typescript-agent-bundle") {
    blockers.push("runtime semantics must stay in the TypeScript agent bundle");
  }
  if (definition.nativeRole !== "bridge-only") {
    blockers.push("native code must be a bridge, not the agent runtime owner");
  }
  if (!definition.productionLocalAllowed) {
    blockers.push(`${id} is not approved for production local iOS runtime`);
  }
  if (!definition.appStoreAllowed) {
    blockers.push(`${id} is not approved for App Store local-runtime builds`);
  }
  if (definition.supportsDynamicNativeCode) {
    blockers.push("dynamic native code loading is not allowed");
  }
  if (definition.supportsCodingAgentsInApp) {
    blockers.push(
      "coding agents must run in a sandbox, cloud, or trusted host",
    );
  }
  if (!definition.supportsHttpRequestBridge) {
    blockers.push("http_request bridge support is required");
  }
  if (!definition.supportsSendMessage) {
    blockers.push("send_message bridge support is required");
  }
  return blockers;
}

export function selectIosLocalRuntimeBackend(
  input: IosLocalRuntimeBackendSelectionInput,
): IosLocalRuntimeBackendSelection {
  if (input.fullBunEngineAvailable) {
    const definition = getIosLocalRuntimeBackendDefinition("full-bun-engine");
    return {
      backend: definition.id,
      definition,
      reason: "ElizaBunEngine.xcframework is available",
      warnings: [],
    };
  }

  if (input.requireProductionSafe) {
    return {
      backend: null,
      definition: null,
      reason:
        "production local iOS runtime requires ElizaBunEngine.xcframework",
      warnings: [
        "swift-bun-jscore and ittp-jscontext are bridge compatibility paths only",
      ],
    };
  }

  if (input.allowSwiftBunCandidate && input.swiftBunJscoreAvailable) {
    const definition = getIosLocalRuntimeBackendDefinition("swift-bun-jscore");
    return {
      backend: definition.id,
      definition,
      reason:
        "SwiftBun-compatible JavaScriptCore bridge was explicitly enabled",
      warnings: getIosLocalRuntimeProductionBlockers(definition.id),
    };
  }

  if (input.allowIttpCompatibilityFallback) {
    const definition = getIosLocalRuntimeBackendDefinition("ittp-jscontext");
    return {
      backend: definition.id,
      definition,
      reason: "using JSContext ITTP compatibility fallback",
      warnings: getIosLocalRuntimeProductionBlockers(definition.id),
    };
  }

  return {
    backend: null,
    definition: null,
    reason: "no iOS local runtime backend is available",
    warnings: [
      "provide ElizaBunEngine.xcframework or explicitly enable a compatibility backend",
    ],
  };
}
