import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { logger } from "@elizaos/core";

const execAsync = promisify(exec);

type WhisperModule = {
  transcribe: (audioBuffer: Buffer, options?: Record<string, unknown>) => Promise<string>;
};
let whisperModule: WhisperModule | null = null;
async function getWhisper(): Promise<WhisperModule> {
  if (!whisperModule) {
    const module = await import("whisper-node");
    whisperModule = (module as { whisper: WhisperModule }).whisper;
  }
  return whisperModule;
}

interface TranscriptionResult {
  text: string;
}

export class TranscribeManager {
  private static instance: TranscribeManager | null = null;
  private cacheDir: string;
  private ffmpegAvailable = false;
  private ffmpegVersion: string | null = null;
  private ffmpegPath: string | null = null;
  private ffmpegInitialized = false;

  private constructor(cacheDir: string) {
    this.cacheDir = path.join(cacheDir, "whisper");
    logger.debug("Initializing TranscribeManager", {
      cacheDir: this.cacheDir,
      timestamp: new Date().toISOString(),
    });
    this.ensureCacheDirectory();
  }

  public async ensureFFmpeg(): Promise<boolean> {
    if (!this.ffmpegInitialized) {
      try {
        await this.initializeFFmpeg();
        this.ffmpegInitialized = true;
      } catch (error) {
        logger.error("FFmpeg initialization failed:", {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          timestamp: new Date().toISOString(),
        });
        return false;
      }
    }
    return this.ffmpegAvailable;
  }

  public isFFmpegAvailable(): boolean {
    return this.ffmpegAvailable;
  }

  public async getFFmpegVersion(): Promise<string | null> {
    if (!this.ffmpegVersion) {
      await this.fetchFFmpegVersion();
    }
    return this.ffmpegVersion;
  }

  private async fetchFFmpegVersion(): Promise<void> {
    try {
      const { stdout } = await execAsync("ffmpeg -version");
      this.ffmpegVersion = stdout.split("\n")[0];
      logger.info("FFmpeg version:", {
        version: this.ffmpegVersion,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.ffmpegVersion = null;
      logger.error("Failed to get FFmpeg version:", {
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      });
    }
  }

  private async initializeFFmpeg(): Promise<void> {
    try {
      await this.checkFFmpegAvailability();

      if (this.ffmpegAvailable) {
        await this.fetchFFmpegVersion();

        await this.verifyFFmpegCapabilities();

        logger.success("FFmpeg initialized successfully", {
          version: this.ffmpegVersion,
          path: this.ffmpegPath,
          timestamp: new Date().toISOString(),
        });
      } else {
        this.logFFmpegInstallInstructions();
      }
    } catch (error) {
      this.ffmpegAvailable = false;
      logger.error("FFmpeg initialization failed:", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString(),
      });
      this.logFFmpegInstallInstructions();
    }
  }

  private async checkFFmpegAvailability(): Promise<void> {
    try {
      const { stdout, stderr } = await execAsync("which ffmpeg || where ffmpeg");
      this.ffmpegPath = stdout.trim();
      this.ffmpegAvailable = true;
      logger.info("FFmpeg found at:", {
        path: this.ffmpegPath,
        stderr: stderr ? stderr.trim() : undefined,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.ffmpegAvailable = false;
      this.ffmpegPath = null;
      logger.error("FFmpeg not found in PATH:", {
        error: error instanceof Error ? error.message : String(error),
        stderr: error instanceof Error && "stderr" in error ? error.stderr : undefined,
        timestamp: new Date().toISOString(),
      });
    }
  }

  private async verifyFFmpegCapabilities(): Promise<void> {
    try {
      const { stdout } = await execAsync("ffmpeg -codecs");
      const hasRequiredCodecs = stdout.includes("pcm_s16le") && stdout.includes("wav");

      if (!hasRequiredCodecs) {
        throw new Error("FFmpeg installation missing required codecs (pcm_s16le, wav)");
      }
    } catch (error) {
      logger.error("FFmpeg capabilities verification failed:", {
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      });
      throw error;
    }
  }

  private logFFmpegInstallInstructions(): void {
    logger.warn("FFmpeg is required but not properly installed. Please install FFmpeg:", {
      instructions: {
        mac: "brew install ffmpeg",
        ubuntu: "sudo apt-get install ffmpeg",
        windows: "choco install ffmpeg",
        manual: "Download from https://ffmpeg.org/download.html",
      },
      requiredVersion: "4.0 or later",
      requiredCodecs: ["pcm_s16le", "wav"],
      timestamp: new Date().toISOString(),
    });
  }

  public static getInstance(cacheDir: string): TranscribeManager {
    if (!TranscribeManager.instance) {
      TranscribeManager.instance = new TranscribeManager(cacheDir);
    }
    return TranscribeManager.instance;
  }

  private ensureCacheDirectory(): void {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  private async convertToWav(inputPath: string, outputPath: string): Promise<void> {
    if (!this.ffmpegAvailable) {
      throw new Error(
        "FFmpeg is not installed or not properly configured. Please install FFmpeg to use audio transcription."
      );
    }

    try {
      const { stderr } = await execAsync(
        `ffmpeg -y -loglevel error -i "${inputPath}" -acodec pcm_s16le -ar 16000 -ac 1 "${outputPath}"`
      );

      if (stderr) {
        logger.warn("FFmpeg conversion error:", {
          stderr,
          inputPath,
          outputPath,
          timestamp: new Date().toISOString(),
        });
      }

      if (!fs.existsSync(outputPath)) {
        throw new Error("WAV file was not created successfully");
      }
    } catch (error) {
      logger.error("Audio conversion failed:", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        command: `ffmpeg -y -loglevel error -i "${inputPath}" -acodec pcm_s16le -ar 16000 -ac 1 "${outputPath}"`,
        ffmpegAvailable: this.ffmpegAvailable,
        ffmpegVersion: this.ffmpegVersion,
        ffmpegPath: this.ffmpegPath,
        timestamp: new Date().toISOString(),
      });
      throw new Error(
        `Failed to convert audio to WAV format: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async preprocessAudio(audioBuffer: Buffer): Promise<string> {
    if (!this.ffmpegAvailable) {
      throw new Error("FFmpeg is not installed. Please install FFmpeg to use audio transcription.");
    }

    try {
      const isWav =
        audioBuffer.length > 4 &&
        audioBuffer.toString("ascii", 0, 4) === "RIFF" &&
        audioBuffer.length > 12 &&
        audioBuffer.toString("ascii", 8, 12) === "WAVE";

      const extension = isWav ? ".wav" : "";
      const tempInputFile = path.join(this.cacheDir, `temp_input_${Date.now()}${extension}`);
      const tempWavFile = path.join(this.cacheDir, `temp_${Date.now()}.wav`);

      fs.writeFileSync(tempInputFile, audioBuffer);

      if (isWav) {
        try {
          const { stdout } = await execAsync(
            `ffprobe -v error -show_entries stream=sample_rate,channels,bits_per_raw_sample -of json "${tempInputFile}"`
          );
          const probeResult = JSON.parse(stdout);
          const stream = probeResult.streams?.[0];

          if (
            stream?.sample_rate === "16000" &&
            stream?.channels === 1 &&
            (stream?.bits_per_raw_sample === 16 || stream?.bits_per_raw_sample === undefined)
          ) {
            fs.renameSync(tempInputFile, tempWavFile);
            return tempWavFile;
          }
        } catch (probeError) {
          logger.debug("FFprobe failed, continuing with conversion:", probeError);
        }
      }

      await this.convertToWav(tempInputFile, tempWavFile);

      if (fs.existsSync(tempInputFile)) {
        fs.unlinkSync(tempInputFile);
      }

      return tempWavFile;
    } catch (error) {
      logger.error("Audio preprocessing failed:", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        ffmpegAvailable: this.ffmpegAvailable,
        timestamp: new Date().toISOString(),
      });
      throw new Error(
        `Failed to preprocess audio: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  public async transcribe(audioBuffer: Buffer): Promise<TranscriptionResult> {
    await this.ensureFFmpeg();

    if (!this.ffmpegAvailable) {
      throw new Error(
        "FFmpeg is not installed or not properly configured. Please install FFmpeg to use audio transcription."
      );
    }

    try {
      const wavFile = await this.preprocessAudio(audioBuffer);

      logger.info("Starting transcription with whisper...");

      let segments: Array<{ speech?: string }> | null = null;
      try {
        const whisper = await getWhisper();

        segments = await whisper(wavFile, {
          modelName: "tiny",
          modelPath: path.join(this.cacheDir, "models"),
          whisperOptions: {
            language: "en",
            word_timestamps: false,
          },
        });
      } catch (whisperError) {
        const errorMessage =
          whisperError instanceof Error ? whisperError.message : String(whisperError);
        if (errorMessage.includes("not found") || errorMessage.includes("download")) {
          logger.error("Whisper model not found. Please run: npx whisper-node download");
          throw new Error(
            "Whisper model not found. Please install it with: npx whisper-node download"
          );
        }

        logger.error("Whisper transcription error:", whisperError);
        throw whisperError;
      }

      if (fs.existsSync(wavFile)) {
        fs.unlinkSync(wavFile);
        logger.info("Temporary WAV file cleaned up");
      }

      if (!segments || !Array.isArray(segments)) {
        logger.warn("Whisper returned no segments (likely silence or very short audio)");
        return { text: "" };
      }

      if (segments.length === 0) {
        logger.warn("No speech detected in audio");
        return { text: "" };
      }

      const cleanText = segments
        .map((segment: { speech?: string }) => segment.speech?.trim() || "")
        .filter((text: string) => text)
        .join(" ");

      logger.success("Transcription complete:", {
        textLength: cleanText.length,
        segmentCount: segments.length,
        timestamp: new Date().toISOString(),
      });

      return { text: cleanText };
    } catch (error) {
      logger.error("Transcription failed:", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        ffmpegAvailable: this.ffmpegAvailable,
      });
      throw error;
    }
  }
}
