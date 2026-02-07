/**
 * TalkMode Plugin for Electron
 *
 * Provides full conversation mode with STT → chat → TTS on desktop platforms.
 *
 * STT Options:
 * - Web Speech API (online, Chrome-based)
 * - Whisper.cpp via Node.js bindings (offline, requires setup)
 *
 * TTS Options:
 * - ElevenLabs API streaming (online, high quality)
 * - System TTS via speechSynthesis API
 * - Native TTS via Electron IPC (platform-specific)
 */
import type { PluginListenerHandle } from "@capacitor/core";
import type { TalkModePlugin, TalkModeConfig, TalkModeState, TalkModePermissionStatus, SpeakOptions, SpeakResult, TalkModeStateEvent, TalkModeTranscriptEvent, TTSSpeakingEvent, TTSCompleteEvent, TalkModeErrorEvent } from "../../src/definitions";
type IpcPrimitive = string | number | boolean | null | undefined;
type IpcObject = {
    [key: string]: IpcValue;
};
type IpcValue = IpcPrimitive | IpcObject | IpcValue[] | ArrayBuffer | Float32Array | Uint8Array;
type IpcListener = (...args: IpcValue[]) => void;
interface ElectronAPI {
    ipcRenderer: {
        invoke(channel: string, ...args: IpcValue[]): Promise<IpcValue>;
        send(channel: string, ...args: IpcValue[]): void;
        on(channel: string, listener: IpcListener): void;
        removeListener(channel: string, listener: IpcListener): void;
    };
}
declare global {
    interface Window {
        electron?: ElectronAPI;
    }
}
/**
 * TalkMode Plugin implementation for Electron
 */
export declare class TalkModeElectron implements TalkModePlugin {
    private config;
    private state;
    private statusText;
    private enabled;
    private isSpeakingValue;
    private usedSystemTts;
    private listeners;
    private recognition;
    private synthesis;
    private currentUtterance;
    private audioContext;
    private audioSource;
    private captureContext;
    private captureStream;
    private captureProcessor;
    private captureGain;
    private captureSampleRate;
    private pendingNativeSpeakResolve;
    private pendingNativeSpeakComplete;
    private awaitingNativeAudio;
    private ipcHandlers;
    constructor();
    start(options?: {
        config?: TalkModeConfig;
    }): Promise<{
        started: boolean;
        error?: string;
    }>;
    private setupElectronListeners;
    private removeElectronListeners;
    stop(): Promise<void>;
    isEnabled(): Promise<{
        enabled: boolean;
    }>;
    getState(): Promise<{
        state: TalkModeState;
        statusText: string;
    }>;
    updateConfig(options: {
        config: Partial<TalkModeConfig>;
    }): Promise<void>;
    speak(options: SpeakOptions): Promise<SpeakResult>;
    private speakWithElevenLabs;
    private playAudioBuffer;
    private playBase64Audio;
    private startAudioCapture;
    private stopAudioCapture;
    private downsampleBuffer;
    private stopAudio;
    private speakWithSystemTts;
    private resolveNativeSpeak;
    private handleNativeSpeakComplete;
    private handleNativeAudioComplete;
    stopSpeaking(): Promise<{
        interruptedAt?: number;
    }>;
    isSpeaking(): Promise<{
        speaking: boolean;
    }>;
    checkPermissions(): Promise<TalkModePermissionStatus>;
    requestPermissions(): Promise<TalkModePermissionStatus>;
    private setState;
    private notifyListeners;
    addListener(eventName: "stateChange", listenerFunc: (event: TalkModeStateEvent) => void): Promise<PluginListenerHandle>;
    addListener(eventName: "transcript", listenerFunc: (event: TalkModeTranscriptEvent) => void): Promise<PluginListenerHandle>;
    addListener(eventName: "speaking", listenerFunc: (event: TTSSpeakingEvent) => void): Promise<PluginListenerHandle>;
    addListener(eventName: "speakComplete", listenerFunc: (event: TTSCompleteEvent) => void): Promise<PluginListenerHandle>;
    addListener(eventName: "error", listenerFunc: (event: TalkModeErrorEvent) => void): Promise<PluginListenerHandle>;
    removeAllListeners(): Promise<void>;
}
export declare const TalkMode: TalkModeElectron;
export {};
//# sourceMappingURL=index.d.ts.map