// spec/os/voice/invocation.md, "Story: Start voice from a trusted gesture, once"; spec/os/voice/invocation.md, "Without an admitted listener a listener launch only opens the assistant"
export const LISTENER_STATES = [
  "OFF",
  "PERMISSION_REQUIRED",
  "NOTIFICATIONS_REQUIRED",
  "STOPPED_AFTER_ERRORS",
  "STOPPED_INDICATOR_LOST",
  "PAUSED_OTHER_USER",
  "WAITING_FOR_UNLOCK",
  "SPEECH_UNAVAILABLE",
  "INDICATOR_UNAVAILABLE",
  "PAUSED_USER",
  "PAUSED_CALL",
  "PAUSED_MIC_IN_USE",
  "PAUSED_MIC_UNAVAILABLE",
  "PAUSED_DISPLAY_OFF",
  "PAUSED_FULLSCREEN",
  "PAUSED_SHADE",
  "PAUSED_TRANSITION",
  "LISTENING",
] as const;

export type ListenerState = (typeof LISTENER_STATES)[number];

export type ListenerStatus =
  | { readonly available: false; readonly reason?: "not-installed" }
  | {
      readonly available: true;
      readonly state: ListenerState;
      readonly label: string;
      readonly consented: boolean;
      readonly listening: boolean;
      readonly microphoneOpen: boolean;
    };

export type ListenerStopReceipt =
  | { readonly available: false }
  | (Extract<ListenerStatus, { available: true }> & { readonly saved: true; readonly listening: false; readonly microphoneOpen: false });

export type ListenerStopAction = "pause" | "turnOff";

export type AssistantInvocation = "listener" | "system" | "power" | "assist" | null;

export type InvocationSessionKey = string & { readonly __brand: "InvocationSessionKey" };

export interface InvocationBinding {
  readonly generation: number;
  readonly bindingId: string;
}

export interface SensePlugin {
  status(): Promise<unknown>;
  pause(): Promise<unknown>;
  turnOff(): Promise<unknown>;
  openSettings(): Promise<{ opened: boolean }>;
  bindInvocationSession(options: InvocationBinding & { readonly sessionKey: string | null }): Promise<void>;
  discardProtectedPowerInvocation?(options: InvocationBinding & { readonly sessionKey: string }): Promise<void>;
  claimProtectedPowerLaunch?(options: InvocationBinding & { readonly sessionKey: string; readonly accountRef: string }): Promise<unknown>;
  discardProtectedPowerLaunch?(options: InvocationBinding & { readonly sessionKey: string | null }): Promise<void>;
  takeInvocation(options: InvocationBinding & { readonly sessionKey: string }): Promise<unknown>;
}

export type SenseInvocationNative = Pick<
  SensePlugin,
  "bindInvocationSession" | "takeInvocation" | "discardProtectedPowerInvocation" | "claimProtectedPowerLaunch" | "discardProtectedPowerLaunch"
>;

export interface SenseInvocationHost {
  authority(): string | null;
  ready(): boolean;
  initialRestorePending?(): boolean;
  powerAccountRef?(): string | null;
  voiceActive(): boolean;
  startVoice(): void;
  subscribe?(changed: () => void): () => void;
  events?: readonly string[];
}

export interface SenseScreen {
  hidden(): boolean;
  dialogOpen(): boolean;
  watch(events: readonly string[], changed: () => void): () => void;
}

export interface SenseVoiceEntryPolicy {
  readonly externalInvocation: boolean;
}

export interface ListenerVoiceInput {
  readonly invocation: AssistantInvocation;
  readonly unlocked: boolean;
  readonly hidden: boolean;
  readonly dialogOpen: boolean;
  readonly connectionOpen: boolean;
  readonly voiceActive: boolean;
}

export interface SenseInvocationController {
  /** @throws {never} */
  check(): void;
  /** @throws {never} */
  dispose(): void;
}
