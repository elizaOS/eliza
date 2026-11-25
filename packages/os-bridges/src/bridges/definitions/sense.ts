// spec/os/voice/listener.md, "Story: Keep wake listening on the device under my control"; spec/os/voice/invocation.md, "Story: Start voice from a trusted gesture, once"

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

export type ListenerStopReceipt =
  | { available: false }
  | (Extract<ListenerStatus, { available: true }> & {
      saved: true;
      listening: false;
      microphoneOpen: false;
    });

export type AssistantInvocation = "listener" | "system" | "power" | "assist" | null;

export interface SenseVoiceEntryPolicy {
  readonly externalInvocation: boolean;
}

export interface SensePlugin {
  status(): Promise<ListenerStatus>;
  pause(): Promise<ListenerStopReceipt>;
  turnOff(): Promise<ListenerStopReceipt>;
  openSettings(): Promise<{ opened: boolean }>;
  bindInvocationSession(options: { generation: number; bindingId: string; sessionKey: string | null }): Promise<void>;
  discardProtectedPowerInvocation?(options: { generation: number; bindingId: string; sessionKey: string }): Promise<void>;
  claimProtectedPowerLaunch?(options: { generation: number; bindingId: string; sessionKey: string; accountRef: string }): Promise<unknown>;
  discardProtectedPowerLaunch?(options: { generation: number; bindingId: string; sessionKey: string | null }): Promise<void>;
  takeInvocation(options: { generation: number; bindingId: string; sessionKey: string }): Promise<unknown>;
}
