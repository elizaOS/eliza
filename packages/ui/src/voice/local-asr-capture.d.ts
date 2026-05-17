export interface LocalAsrRecorder {
    stop(): Promise<Uint8Array>;
    cancel(): void;
}
export interface PcmAudioStats {
    rms: number;
    peak: number;
}
export declare function isLocalAsrCaptureSupported(): boolean;
export declare function measurePcmAudio(pcm: Float32Array): PcmAudioStats;
export declare function isSilentPcmAudio(pcm: Float32Array): boolean;
export declare function encodeMonoPcm16Wav(pcm: Float32Array, sampleRateHz: number): Uint8Array;
export declare function startLocalAsrRecorder(): Promise<LocalAsrRecorder>;
//# sourceMappingURL=local-asr-capture.d.ts.map