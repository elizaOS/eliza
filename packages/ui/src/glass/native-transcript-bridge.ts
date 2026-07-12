/**
 * TS side of the `NativeTranscript` Capacitor plugin: hands the serialized
 * transcript frame (see `chat/native-transcript/spec.ts`) to a platform-native
 * renderer (iOS SwiftUI / Android Compose) mounted at a webview-anchored rect,
 * and receives the widget action strings back on the SAME channel the DOM
 * widgets use (`sendActionMessage`) — the app cannot tell which renderer
 * produced an action. Mirrors the GlassBridge conventions: lazy bridge-global
 * resolution (no static @capacitor/core import — this file rides the barrel
 * into Node), memoized availability, capability-probe error policy.
 */
import type {
  NativeTranscriptAction,
  NativeTranscriptFrame,
} from "../chat/native-transcript/spec";

export interface NativeTranscriptRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface NativeTranscriptPlugin {
  isAvailable(): Promise<{ available: boolean }>;
  /** Full-frame replace; the native side diffs by message id. */
  setTranscript(options: { frame: NativeTranscriptFrame }): Promise<void>;
  /** Mount/move the native list at a viewport-relative CSS-pixel rect. */
  show(options: { rect: NativeTranscriptRect }): Promise<void>;
  hide(): Promise<void>;
  addListener(
    event: "transcriptAction",
    handler: (action: NativeTranscriptAction) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  registerPlugin?: <T>(name: string) => T;
  Plugins?: Record<string, unknown>;
}

function capacitorGlobal(): CapacitorGlobal | null {
  return (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor ?? null;
}

let cached: NativeTranscriptPlugin | null | undefined;

export function nativeTranscriptBridge(): NativeTranscriptPlugin | null {
  if (cached !== undefined) return cached;
  const cap = capacitorGlobal();
  const platform = cap?.getPlatform?.();
  if (
    !cap?.isNativePlatform?.() ||
    (platform !== "ios" && platform !== "android")
  ) {
    cached = null;
    return cached;
  }
  try {
    cached = cap.registerPlugin
      ? cap.registerPlugin<NativeTranscriptPlugin>("NativeTranscript")
      : ((cap.Plugins?.NativeTranscript as NativeTranscriptPlugin | null) ??
        null);
  } catch {
    // error-policy:J4 capability probe — unregistered plugin IS "no native
    // transcript"; callers stay on the DOM renderer.
    cached = null;
  }
  return cached ?? null;
}

let availability: Promise<boolean> | null = null;

export function isNativeTranscriptAvailable(): Promise<boolean> {
  if (availability) return availability;
  availability = (async () => {
    const bridge = nativeTranscriptBridge();
    if (!bridge) return false;
    try {
      return (await bridge.isAvailable()).available;
    } catch {
      // error-policy:J4 capability probe — an older shell without the plugin
      // is honestly "unavailable", never a crash.
      return false;
    }
  })();
  return availability;
}

/** Test seam: reset memoized plugin + availability between cases. */
export function resetNativeTranscriptBridgeForTests(): void {
  cached = undefined;
  availability = null;
}
