/**
 * TS side of the `NativeComposer` Capacitor plugin + its `NativeSurfaceDriver`:
 * a real native text field (iOS `UITextView`/SwiftUI `TextEditor`, Android
 * `EditText`) mounted ABOVE the webview over the DOM composer's text rect, used
 * only in the maximized chat where the surface is at rest (see the gate in
 * ChatOverlay / NativeComposerInput). Native owns the text buffer + first
 * responder + IME; React keeps mirroring `draft` for send/persist/slash. The
 * plugin emits high-level INTENTS (`change`/`submit`/`escape`/`focus`/`blur`) —
 * the composer's IME/paste/slash/send BRAINS stay in JS (`chat/composer-core`).
 *
 * Mirrors `native-transcript-bridge.ts`: reads the bridge-injected
 * `globalThis.Capacitor` (never a static `@capacitor/core` import, so the
 * `@elizaos/ui` barrel stays importable under plain Node), memoized availability,
 * capability-probe error policy. Off-native (web/desktop-without-driver) every
 * call resolves as a no-op and the driver's `attach` returns null → the DOM
 * `<Textarea>` stands.
 */

import type {
  NativeSurfaceDriver,
  NativeSurfaceGeometry,
  NativeSurfaceHandle,
} from "./native-surface";

/** Props the DOM mirrors onto the native field. */
export interface NativeComposerProps {
  draft: string;
  placeholder: string;
  disabled: boolean;
  colorScheme?: "light" | "dark" | "system";
}

/** High-level intents the native field forwards; JS runs the same handlers. */
export type NativeComposerEvent =
  | { kind: "change"; value: string }
  | { kind: "submit" }
  | { kind: "escape" }
  | { kind: "focus" }
  | { kind: "blur" };

interface NativeComposerRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface NativeComposerPlugin {
  attach(options: {
    id: string;
    rect: NativeComposerRect;
    draft: string;
    placeholder: string;
    disabled: boolean;
    colorScheme?: string;
  }): Promise<{ attached: boolean }>;
  updateRect(options: { id: string; rect: NativeComposerRect }): Promise<void>;
  setProps(options: {
    id: string;
    draft?: string;
    placeholder?: string;
    disabled?: boolean;
  }): Promise<void>;
  detach(options: { id: string }): Promise<void>;
  isAvailable(): Promise<{ available: boolean }>;
  addListener(
    eventName: "composerEvent",
    handler: (event: NativeComposerEvent & { id: string }) => void,
  ): Promise<{ remove: () => void }> | { remove: () => void };
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

let cached: NativeComposerPlugin | null | undefined;

export function nativeComposerBridge(): NativeComposerPlugin | null {
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
      ? cap.registerPlugin<NativeComposerPlugin>("NativeComposer")
      : ((cap.Plugins?.NativeComposer as NativeComposerPlugin | undefined) ??
        null);
  } catch {
    // error-policy:J4 capability probe — an unregistered plugin IS the "no
    // native composer" answer; the DOM textarea stands.
    cached = null;
  }
  return cached ?? null;
}

let availability: Promise<boolean> | null = null;

export function isNativeComposerAvailable(): Promise<boolean> {
  if (availability) return availability;
  availability = (async () => {
    const bridge = nativeComposerBridge();
    if (!bridge) return false;
    try {
      return (await bridge.isAvailable()).available;
    } catch {
      // error-policy:J4 capability probe — a throwing/older plugin is honestly
      // "unavailable", never a crash.
      return false;
    }
  })();
  return availability;
}

/** Test seam: reset memoized plugin + availability between cases. */
export function resetNativeComposerBridgeForTests(): void {
  cached = undefined;
  availability = null;
}

/**
 * The composer's `NativeSurfaceDriver`. `attach` mounts the native field, wires
 * one `composerEvent` listener (filtered by region id), and returns a handle
 * whose `setProps` mirrors draft/placeholder/disabled. Returns null off-native.
 */
export const nativeComposerDriver: NativeSurfaceDriver<
  NativeComposerProps,
  NativeComposerEvent
> = {
  name: "composer",
  isAvailable: isNativeComposerAvailable,
  async attach(id, geo, props, onEvent) {
    if (!(await isNativeComposerAvailable())) return null;
    const bridge = nativeComposerBridge();
    if (!bridge) return null;
    const rect = geoToRect(geo);
    let result: { attached: boolean };
    try {
      result = await bridge.attach({
        id,
        rect,
        draft: props.draft,
        placeholder: props.placeholder,
        disabled: props.disabled,
        colorScheme: props.colorScheme,
      });
    } catch {
      // error-policy:J4 — attach failed at the native boundary; degrade to DOM.
      return null;
    }
    if (!result.attached) return null;
    const sub = await bridge.addListener("composerEvent", (event) => {
      if (event.id === id) onEvent(event);
    });
    const handle: NativeSurfaceHandle<NativeComposerProps> = {
      updateGeometry(next) {
        void bridge.updateRect({ id, rect: geoToRect(next) });
      },
      setProps(patch) {
        void bridge.setProps({ id, ...patch });
      },
      detach() {
        sub.remove();
        void bridge.detach({ id });
      },
    };
    return handle;
  },
};

function geoToRect(geo: NativeSurfaceGeometry): NativeComposerRect {
  return { x: geo.x, y: geo.y, width: geo.width, height: geo.height };
}
