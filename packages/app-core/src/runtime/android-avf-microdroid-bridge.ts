import type {
  AndroidAvfMicrodroidBoundary,
  MobileSafeRuntimeCapabilityRequest,
  MobileSafeRuntimeCapabilityResponse,
  MobileSafeRuntimeFeatureProbe,
} from "./mobile-safe-runtime";

export interface AndroidVirtualizationNativeBridge {
  getAndroidVirtualization?: () => string | null | undefined;
  isAndroidVirtualizationAvailable?: () => boolean;
  requestAndroidVirtualization?: (
    requestJson: string,
  ) => string | null | undefined;
}

export interface AndroidVirtualizationProbePayload {
  available?: boolean;
  microdroidAvailable?: boolean;
  apiLevel?: number;
  hasFeature?: boolean;
  hasPermissionDeclaration?: boolean;
  hasPermissionGrant?: boolean;
  hasVirtualizationService?: boolean;
  capabilities?: string[];
  reason?: string;
}

export function createAndroidAvfMicrodroidFeatureProbe(
  scope: { ElizaNative?: AndroidVirtualizationNativeBridge } = globalThis as {
    ElizaNative?: AndroidVirtualizationNativeBridge;
  },
): MobileSafeRuntimeFeatureProbe {
  const payload = readAndroidVirtualizationProbe(scope.ElizaNative);
  return {
    platform: "android",
    androidAvfAvailable: payload?.available === true,
    androidMicrodroidAvailable: payload?.microdroidAvailable === true,
    env: {
      ELIZA_PLATFORM: "android",
      ...(payload?.available === true
        ? { ELIZA_ANDROID_AVF_AVAILABLE: "1" }
        : {}),
      ...(payload?.microdroidAvailable === true
        ? { ELIZA_ANDROID_MICRODROID_AVAILABLE: "1" }
        : {}),
    },
    globals: {
      AndroidVirtualization: payload,
    },
  };
}

export function createAndroidAvfMicrodroidBoundaryFromNative(
  scope: { ElizaNative?: AndroidVirtualizationNativeBridge } = globalThis as {
    ElizaNative?: AndroidVirtualizationNativeBridge;
  },
): AndroidAvfMicrodroidBoundary | undefined {
  const bridge = scope.ElizaNative;
  if (typeof bridge?.requestAndroidVirtualization !== "function") {
    return undefined;
  }

  return {
    kind: "android-avf-microdroid",
    async request(
      request: MobileSafeRuntimeCapabilityRequest,
    ): Promise<MobileSafeRuntimeCapabilityResponse> {
      const raw = bridge.requestAndroidVirtualization?.(
        JSON.stringify(request),
      );
      return parseNativeResponse(raw, request.id);
    },
  };
}

function readAndroidVirtualizationProbe(
  bridge: AndroidVirtualizationNativeBridge | undefined,
): AndroidVirtualizationProbePayload | undefined {
  if (!bridge || typeof bridge.getAndroidVirtualization !== "function") {
    return undefined;
  }
  const raw = bridge.getAndroidVirtualization();
  if (!raw) return undefined;
  const parsed = safeJsonParse(raw);
  return parsed && typeof parsed === "object"
    ? (parsed as AndroidVirtualizationProbePayload)
    : undefined;
}

function parseNativeResponse(
  raw: string | null | undefined,
  requestId: string,
): MobileSafeRuntimeCapabilityResponse {
  if (!raw) {
    return {
      id: requestId,
      ok: false,
      error: {
        code: "ANDROID_AVF_EMPTY_RESPONSE",
        message: "Android AVF/Microdroid bridge returned no response",
        retryable: false,
      },
    };
  }
  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== "object") {
    return {
      id: requestId,
      ok: false,
      error: {
        code: "ANDROID_AVF_INVALID_RESPONSE",
        message: "Android AVF/Microdroid bridge returned invalid JSON",
        retryable: false,
      },
    };
  }
  return parsed as MobileSafeRuntimeCapabilityResponse;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
