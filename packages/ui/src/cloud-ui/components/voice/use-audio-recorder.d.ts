export interface UseAudioRecorderReturn {
    isRecording: boolean;
    isPaused: boolean;
    recordingTime: number;
    audioBlob: Blob | null;
    error: string | null;
    startRecording: () => Promise<void>;
    stopRecording: () => void;
    pauseRecording: () => void;
    resumeRecording: () => void;
    clearRecording: () => void;
}
export declare function useAudioRecorder(): UseAudioRecorderReturn;
//# sourceMappingURL=use-audio-recorder.d.ts.map