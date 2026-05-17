export interface UseAudioPlayerReturn {
    isPlaying: boolean;
    currentTime: number;
    duration: number;
    error: string | null;
    playAudio: (audioBlob: Blob | string) => Promise<void>;
    pauseAudio: () => void;
    resumeAudio: () => Promise<void>;
    stopAudio: () => void;
    seekTo: (time: number) => void;
}
export declare function useAudioPlayer(): UseAudioPlayerReturn;
//# sourceMappingURL=use-audio-player.d.ts.map