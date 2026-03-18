import { Capacitor, type PluginListenerHandle } from "@capacitor/core";

type NativePlugin = Record<string, unknown>;

/** Capacitor.Plugins exists in Capacitor 3.x but is deprecated; type for compatibility. */
interface CapacitorWithPlugins {
  Plugins?: Record<string, unknown>;
}

/** Window may have Capacitor injected at runtime (Electron/native shells). */
interface WindowWithCapacitor extends Window {
  Capacitor?: { Plugins?: Record<string, unknown> };
}

function getCapacitorPlugins(): Record<string, unknown> {
  const capacitor = Capacitor as CapacitorWithPlugins;
  if (capacitor.Plugins) {
    return capacitor.Plugins;
  }
  if (typeof window !== "undefined") {
    const windowCapacitor = (window as WindowWithCapacitor).Capacitor;
    return windowCapacitor?.Plugins ?? {};
  }
  return {};
}

export function getNativePlugin<T extends NativePlugin>(name: string): T {
  return (getCapacitorPlugins()[name] ?? {}) as T;
}

export interface SwabbleConfig {
  triggers: string[];
  minPostTriggerGap?: number;
  minCommandLength?: number;
  locale?: string;
  sampleRate?: number;
  modelSize?: "tiny" | "base" | "small" | "medium" | "large";
}

export interface SwabbleAudioLevelEvent {
  level: number;
  peak?: number;
}

export interface SwabblePluginLike extends NativePlugin {
  getConfig(): Promise<{ config: SwabbleConfig | null }>;
  isListening(): Promise<{ listening: boolean }>;
  updateConfig(options: { config: Partial<SwabbleConfig> }): Promise<void>;
  start(options: { config: SwabbleConfig }): Promise<{ started: boolean }>;
  stop(): Promise<void>;
  addListener(
    eventName: "audioLevel",
    listenerFunc: (event: SwabbleAudioLevelEvent) => void,
  ): Promise<PluginListenerHandle>;
}

export interface TalkModeTranscriptEvent {
  transcript?: string;
  isFinal?: boolean;
}

export interface TalkModeErrorEvent {
  code?: string;
  message?: string;
}

export interface TalkModeStateEvent {
  state?: string;
}

export interface TalkModePermissionStatus {
  microphone?: "granted" | "denied" | "prompt";
  speechRecognition?: "granted" | "denied" | "prompt" | "not_supported";
}

export interface TalkModePluginLike extends NativePlugin {
  addListener(
    eventName: "transcript",
    listenerFunc: (event: TalkModeTranscriptEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "error",
    listenerFunc: (event: TalkModeErrorEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "stateChange",
    listenerFunc: (event: TalkModeStateEvent) => void,
  ): Promise<PluginListenerHandle>;
  checkPermissions(): Promise<TalkModePermissionStatus>;
  requestPermissions(): Promise<TalkModePermissionStatus>;
  start(options?: {
    config?: {
      stt?: {
        engine?: "whisper" | "web";
        modelSize?: "tiny" | "base" | "small" | "medium" | "large";
        language?: string;
        sampleRate?: number;
      };
      silenceWindowMs?: number;
      interruptOnSpeech?: boolean;
    };
  }): Promise<{ started: boolean; error?: string }>;
  stop(): Promise<void>;
}

export type GenericNativePlugin = NativePlugin;

export function getGatewayPlugin(): GenericNativePlugin {
  return getNativePlugin<GenericNativePlugin>("Gateway");
}

export function getSwabblePlugin(): SwabblePluginLike {
  return getNativePlugin<SwabblePluginLike>("Swabble");
}

export function getTalkModePlugin(): TalkModePluginLike {
  return getNativePlugin<TalkModePluginLike>("TalkMode");
}

export function getCameraPlugin(): GenericNativePlugin {
  return getNativePlugin<GenericNativePlugin>("Camera");
}

export function getLocationPlugin(): GenericNativePlugin {
  return getNativePlugin<GenericNativePlugin>("Location");
}

export function getScreenCapturePlugin(): GenericNativePlugin {
  return getNativePlugin<GenericNativePlugin>("ScreenCapture");
}

export function getCanvasPlugin(): GenericNativePlugin {
  return getNativePlugin<GenericNativePlugin>("Canvas");
}

export function getDesktopPlugin(): GenericNativePlugin {
  return getNativePlugin<GenericNativePlugin>("Desktop");
}
