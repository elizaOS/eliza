declare module 'whisper-node' {
  interface WhisperOptions {
    language?: string;
    gen_file_txt?: boolean;
    gen_file_subtitle?: boolean;
    gen_file_vtt?: boolean;
    word_timestamps?: boolean;
    timestamp_size?: number;
  }

  interface WhisperConfig {
    modelName?: string;
    modelPath?: string;
    whisperOptions?: WhisperOptions;
  }

  interface TranscriptSegment {
    start: string;
    end: string;
    speech: string;
  }

  function whisper(filePath: string, options?: WhisperConfig): Promise<TranscriptSegment[]>;

  const exports: {
    whisper: typeof whisper;
    default: typeof whisper;
  };

  export = exports;
}
