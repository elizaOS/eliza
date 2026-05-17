import type {
  AndroidAvfMicrodroidBoundary,
  AndroidAvfMicrodroidCapabilityState,
  MobileSafeRuntimeFeatureProbe,
} from "./mobile-safe-runtime";
export declare const ANDROID_AVF_MICRODROID_REQUEST_CONTRACT_VERSION = 1;
export interface AndroidVirtualizationNativeBridge {
  getAndroidVirtualization?: () => string | null | undefined;
  isAndroidVirtualizationAvailable?: () => boolean;
  requestAndroidVirtualization?: (
    requestJson: string,
  ) => string | null | undefined;
}
export interface AndroidVirtualizationProbePayload {
  state?: AndroidAvfMicrodroidCapabilityState;
  available?: boolean;
  avfAvailable?: boolean;
  microdroidAvailable?: boolean;
  payloadAvailable?: boolean;
  requestContractVersion?: number;
  apiLevel?: number;
  hasFeature?: boolean;
  hasPermissionDeclaration?: boolean;
  hasPermissionGrant?: boolean;
  hasVirtualizationService?: boolean;
  capabilities?: string[];
  reason?: string;
}
export declare function createAndroidAvfMicrodroidFeatureProbe(scope?: {
  ElizaNative?: AndroidVirtualizationNativeBridge;
}): MobileSafeRuntimeFeatureProbe;
export declare function createAndroidAvfMicrodroidBoundaryFromNative(scope?: {
  ElizaNative?: AndroidVirtualizationNativeBridge;
}): AndroidAvfMicrodroidBoundary | undefined;
//# sourceMappingURL=android-avf-microdroid-bridge.d.ts.map
