declare module "fluent-ffmpeg" {
  export interface FfmpegCommand {
    output(path: string): FfmpegCommand;
    noVideo(): FfmpegCommand;
    audioCodec(codec: string): FfmpegCommand;
    videoCodec(codec: string): FfmpegCommand;
    screenshots(options: {
      timestamps: number[];
      filename: string;
      folder: string;
      size: string;
    }): FfmpegCommand;
    seekInput(seconds: number): FfmpegCommand;
    duration(seconds: number): FfmpegCommand;
    format(format: string): FfmpegCommand;
    size(size: string): FfmpegCommand;
    videoBitrate(bitrate: string | number): FfmpegCommand;
    fps(fps: number): FfmpegCommand;
    on(event: "end", listener: () => void): FfmpegCommand;
    on(event: "error", listener: (error: Error) => void): FfmpegCommand;
    run(): void;
  }

  interface FfmpegFactory {
    (input?: string): FfmpegCommand;
    setFfmpegPath(path: string): void;
  }

  const ffmpeg: FfmpegFactory;
  export default ffmpeg;
}
