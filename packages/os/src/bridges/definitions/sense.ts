// spec/os/voice/listener.md, "Story: Keep wake listening on the device under my control"; spec/os/voice/invocation.md, "Story: Start voice from a trusted gesture, once"
/**
 * Type definitions for the wake listener bridge of @elizaos/os
 * (`@elizaos/os/bridges/definitions/sense`).
 *
 * The native side is android/system/src/main/java/ai/eliza/plugins/system/SensePlugin.java,
 * registered with Capacitor as `ElizaSense`; it relays the image listener's provider. No
 * method here enables or resumes capture: consent and the invocation origin stay native.
 */

/** Every state the image listener reports, as it spells them. */
export type ListenerState =
  | "OFF"
  | "PERMISSION_REQUIRED"
  | "NOTIFICATIONS_REQUIRED"
  | "STOPPED_AFTER_ERRORS"
  | "STOPPED_INDICATOR_LOST"
  | "PAUSED_OTHER_USER"
  | "WAITING_FOR_UNLOCK"
  | "SPEECH_UNAVAILABLE"
  | "INDICATOR_UNAVAILABLE"
  | "PAUSED_USER"
  | "PAUSED_CALL"
  | "PAUSED_MIC_IN_USE"
  | "PAUSED_MIC_UNAVAILABLE"
  | "PAUSED_DISPLAY_OFF"
  | "PAUSED_FULLSCREEN"
  | "PAUSED_SHADE"
  | "PAUSED_TRANSITION"
  | "LISTENING";

/** The listener as the host may show it; `not-installed` means the image has no listener. */
export type ListenerStatus =
  | { available: false; reason?: "not-installed" }
  | {
      available: true;
      state: ListenerState;
      label: string;
      consented: boolean;
      listening: boolean;
      microphoneOpen: boolean;
    };

/** A saved Pause or Turn off action that confirms the provider released the microphone. */
export type ListenerStopReceipt =
  | { available: false }
  | (Extract<ListenerStatus, { available: true }> & {
      saved: true;
      listening: false;
      microphoneOpen: false;
    });

/**
 * Who opened the assistant surface, as native recorded it from Android's caller identity:
 * `listener` (a wake from the same-signer image listener), `system` (a platform assistant
 * gesture), `power` (the host's permission-protected Power activity) or `assist` (any other
 * launch, which only opens the assistant). Null when nothing is pending.
 */
export type AssistantInvocation = "listener" | "system" | "power" | "assist" | null;

/** Whether this host lets an outside invocation start voice; never permission to capture. */
export interface SenseVoiceEntryPolicy {
  readonly externalInvocation: boolean;
}

/** The native `ElizaSense` plugin. */
export interface SensePlugin {
  /** The listener's current status. */
  status(): Promise<ListenerStatus>;
  /** Pauses listening until resumed; the reply is a stop receipt to parse. */
  pause(): Promise<ListenerStopReceipt>;
  /** Turns listening off; the reply is a stop receipt to parse. */
  turnOff(): Promise<ListenerStopReceipt>;
  /** Opens the listener's own settings screen. */
  openSettings(): Promise<{ opened: boolean }>;
  /** Binds this renderer's owner session, or unbinds with a null key. */
  bindInvocationSession(options: { generation: number; bindingId: string; sessionKey: string | null }): Promise<void>;
  /** Drops only the current owner's pending Power receipt when capture cannot start now. */
  discardProtectedPowerInvocation?(options: { generation: number; bindingId: string; sessionKey: string }): Promise<void>;
  /** Consumes only a native-created protected launch grant; it cannot mint one. */
  claimProtectedPowerLaunch?(options: { generation: number; bindingId: string; sessionKey: string; accountRef: string }): Promise<unknown>;
  /** Drops a protected launch grant this binding may hold. */
  discardProtectedPowerLaunch?(options: { generation: number; bindingId: string; sessionKey: string | null }): Promise<void>;
  /** Takes the pending invocation for the bound session; parse it before use. */
  takeInvocation(options: { generation: number; bindingId: string; sessionKey: string }): Promise<unknown>;
}
