export type IosLocalRuntimeBackendId = "full-bun-engine" | "swift-bun-jscore" | "ittp-jscontext";
export type IosLocalRuntimeNativeRole = "bridge-only";
export type IosLocalRuntimeOwner = "typescript-agent-bundle";
export type IosLocalRuntimeReadiness = "production" | "candidate" | "compatibility";
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
export declare const IOS_LOCAL_RUNTIME_BACKENDS: readonly [{
    readonly id: "full-bun-engine";
    readonly readiness: "production";
    readonly runtimeOwner: "typescript-agent-bundle";
    readonly nativeRole: "bridge-only";
    readonly requiresNativeArtifact: true;
    readonly runsInIosAppProcess: true;
    readonly appStoreAllowed: true;
    readonly productionLocalAllowed: true;
    readonly supportsAgentBundle: true;
    readonly supportsHttpRequestBridge: true;
    readonly supportsSendMessage: true;
    readonly supportsNativeLlamaHostCalls: true;
    readonly supportsCodingAgentsInApp: false;
    readonly supportsDynamicNativeCode: false;
}, {
    readonly id: "swift-bun-jscore";
    readonly readiness: "candidate";
    readonly runtimeOwner: "typescript-agent-bundle";
    readonly nativeRole: "bridge-only";
    readonly requiresNativeArtifact: true;
    readonly runsInIosAppProcess: true;
    readonly appStoreAllowed: false;
    readonly productionLocalAllowed: false;
    readonly supportsAgentBundle: false;
    readonly supportsHttpRequestBridge: true;
    readonly supportsSendMessage: true;
    readonly supportsNativeLlamaHostCalls: false;
    readonly supportsCodingAgentsInApp: false;
    readonly supportsDynamicNativeCode: false;
}, {
    readonly id: "ittp-jscontext";
    readonly readiness: "compatibility";
    readonly runtimeOwner: "typescript-agent-bundle";
    readonly nativeRole: "bridge-only";
    readonly requiresNativeArtifact: false;
    readonly runsInIosAppProcess: true;
    readonly appStoreAllowed: false;
    readonly productionLocalAllowed: false;
    readonly supportsAgentBundle: false;
    readonly supportsHttpRequestBridge: true;
    readonly supportsSendMessage: true;
    readonly supportsNativeLlamaHostCalls: false;
    readonly supportsCodingAgentsInApp: false;
    readonly supportsDynamicNativeCode: false;
}];
export declare function getIosLocalRuntimeBackendDefinition(id: IosLocalRuntimeBackendId): IosLocalRuntimeBackendDefinition;
export declare function getIosLocalRuntimeProductionBlockers(id: IosLocalRuntimeBackendId): string[];
export declare function selectIosLocalRuntimeBackend(input: IosLocalRuntimeBackendSelectionInput): IosLocalRuntimeBackendSelection;
//# sourceMappingURL=ios-runtime-backends.d.ts.map
