// Ambient declarations for untyped third-party modules that this package (and the
// plugin source it imports in local mode) pull in. These ship no @types and no
// bundled declarations; declaring the used surface keeps the modules typed under
// noImplicitAny instead of resolving to `any` (TS7016).

declare module "fluent-ffmpeg" {
  export interface FfprobeData {
    streams: Array<{ codec_type?: string; [key: string]: unknown }>;
    format: { [key: string]: unknown };
    [key: string]: unknown;
  }
  export interface FfmpegCommand {
    noVideo(): FfmpegCommand;
    audioCodec(codec: string): FfmpegCommand;
    toFormat(format: string): FfmpegCommand;
    on(event: "end", listener: () => void): FfmpegCommand;
    on(event: "error", listener: (err: Error) => void): FfmpegCommand;
    output(path: string): FfmpegCommand;
    run(): void;
  }
  interface FfmpegFactory {
    (input?: string): FfmpegCommand;
    ffprobe(
      file: string,
      callback: (err: Error | null, data: FfprobeData) => void,
    ): void;
    setFfmpegPath(path: string): void;
  }
  const ffmpeg: FfmpegFactory;
  export default ffmpeg;
}

declare module "pngjs" {
  export class PNG {
    constructor(options?: { width?: number; height?: number });
    width: number;
    height: number;
    data: Buffer;
    static sync: {
      read(buffer: Buffer): PNG;
      write(png: PNG): Buffer;
    };
  }
}
