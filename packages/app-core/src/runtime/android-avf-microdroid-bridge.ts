import type {
  AndroidAvfMicrodroidBoundary,
  AndroidAvfMicrodroidCapabilityState,
  MobileSafeRuntimeCapabilityRequest,
  MobileSafeRuntimeCapabilityResponse,
  MobileSafeRuntimeFeatureProbe,
} from "./mobile-safe-runtime";

export const ANDROID_AVF_MICRODROID_REQUEST_CONTRACT_VERSION = 1;

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

export function createAndroidAvfMicrodroidFeatureProbe(
  scope: { ElizaNative?: AndroidVirtualizationNativeBridge } = globalThis as {
    ElizaNative?: AndroidVirtualizationNativeBridge;
  },
): MobileSafeRuntimeFeatureProbe {
  const payload = readAndroidVirtualizationProbe(scope.ElizaNative);
  const avfAvailable =
    payload?.available === true ||
    payload?.avfAvailable === true ||
    payload?.hasVirtualizationService === true;
  const microdroidAvailable = payload?.microdroidAvailable === true;
  const payloadAvailable = payload?.payloadAvailable === true;
  const state =
    payload?.state ??
    (payloadAvailable && (avfAvailable || microdroidAvailable)
      ? "ready"
      : avfAvailable || microdroidAvailable
        ? "payload-missing"
        : "framework-unavailable");
  return {
    platform: "android",
    androidAvfAvailable: avfAvailable,
    androidMicrodroidAvailable: microdroidAvailable,
    androidAvfPayloadAvailable: payloadAvailable,
    androidAvfCapabilityState: state,
    env: {
      ELIZA_PLATFORM: "android",
      ...(avfAvailable === true ? { ELIZA_ANDROID_AVF_AVAILABLE: "1" } : {}),
      ...(microdroidAvailable === true
        ? { ELIZA_ANDROID_MICRODROID_AVAILABLE: "1" }
        : {}),
      ...(payloadAvailable === true
        ? { ELIZA_ANDROID_MICRODROID_PAYLOAD_READY: "1" }
        : {}),
      ELIZA_ANDROID_AVF_MICRODROID_STATE: state,
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
  const payload = readAndroidVirtualizationProbe(bridge);
  const state = payload?.state ?? "payload-missing";

  return {
    kind: "android-avf-microdroid",
    capabilityState: state,
    reason: payload?.reason,
    capabilities: payload?.capabilities ?? [],
    async request(
      request: MobileSafeRuntimeCapabilityRequest,
    ): Promise<MobileSafeRuntimeCapabilityResponse> {
      if (state !== "ready") {
        return avfUnavailableResponse(
          request.id,
          state === "payload-missing"
            ? "ANDROID_AVF_MICRODROID_PAYLOAD_MISSING"
            : "ANDROID_AVF_UNAVAILABLE",
          payload?.reason ??
            "Android AVF/Microdroid is not ready for request execution",
        );
      }
      const raw = bridge.requestAndroidVirtualization?.(
        JSON.stringify({
          ...request,
          contractVersion: ANDROID_AVF_MICRODROID_REQUEST_CONTRACT_VERSION,
        }),
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
  const response = parsed as Partial<MobileSafeRuntimeCapabilityResponse>;
  if (response.id !== requestId) {
    return {
      id: requestId,
      ok: false,
      error: {
        code: "ANDROID_AVF_INVALID_RESPONSE",
        message:
          "Android AVF/Microdroid bridge returned a mismatched response id",
        retryable: false,
      },
    };
  }
  if (response.ok === true && "result" in response) {
    return response as MobileSafeRuntimeCapabilityResponse;
  }
  if (
    response.ok === false &&
    response.error &&
    typeof response.error.code === "string" &&
    typeof response.error.message === "string"
  ) {
    return response as MobileSafeRuntimeCapabilityResponse;
  }
  return {
    id: requestId,
    ok: false,
    error: {
      code: "ANDROID_AVF_INVALID_RESPONSE",
      message:
        "Android AVF/Microdroid bridge returned an invalid response shape",
      retryable: false,
    },
  };
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function avfUnavailableResponse(
  id: string,
  code: string,
  message: string,
): MobileSafeRuntimeCapabilityResponse {
  return {
    id,
    ok: false,
    error: {
      code,
      message,
      retryable: false,
    },
  };
}
