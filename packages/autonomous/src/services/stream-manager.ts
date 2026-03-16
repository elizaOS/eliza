/**
 * Stream Manager — cross-platform RTMP streaming via FFmpeg.
 *
 * Supports multiple input modes:
 * - "pipe": Receives JPEG frames via writeFrame() → FFmpeg stdin (image2pipe).
 *   Used for streaming Electron window contents captured with capturePage().
 * - "avfoundation" / "screen": macOS native screen capture.
 * - "x11grab": Linux virtual display capture (Xvfb). Like Hyperscape's approach.
 * - "file": Reads a continuously-updated JPEG file (browser-capture).
 * - "testsrc": Solid color test pattern (default fallback).
 *
 * Audio support:
 * - "silent": Synthetic silent audio (anullsrc) — default.
 * - "system": System/desktop audio capture.
 * - "microphone": Microphone input.
 * - File path: Play an audio file as stream audio.
 *
 * Volume control:
 * - setVolume(0-100), mute(), unmute() — restarts FFmpeg to apply.
 *
 * Usage:
 *   import { streamManager } from "./services/stream-manager";
 *   await streamManager.start({ rtmpUrl, rtmpKey, inputMode: "pipe" });
 *   streamManager.writeFrame(jpegBuffer); // called from frame capture
 *   streamManager.setVolume(50);          // adjust volume mid-stream
 *   await streamManager.stop();
 *
 * @module services/stream-manager
 */

import { type ChildProcess, execSync, spawn } from "node:child_process";
import { logger } from "@elizaos/core";
import { type ITtsStreamBridge, ttsStreamBridge } from "./tts-stream-bridge";

const TAG = "[StreamManager]";

export type AudioSource = "silent" | "system" | "microphone" | "tts";

export interface StreamConfig {
  rtmpUrl: string;
  rtmpKey: string;
  /** FFmpeg video input source. Defaults to "testsrc" (test pattern). */
  inputMode?:
    | "testsrc"
    | "avfoundation"
    | "screen"
    | "pipe"
    | "file"
    | "x11grab";
  /** avfoundation video device index (default "3" = Capture screen 0 on macOS) */
  videoDevice?: string;
  /** Path to JPEG frame file (for "file" input mode) */
  frameFile?: string;
  /** Resolution (default "1280x720") */
  resolution?: string;
  /** Video bitrate (default "2500k") */
  bitrate?: string;
  /** Frame rate (default 15) */
  framerate?: number;
  /** X11 display for x11grab mode (e.g., ":99"). Default ":99". */
  display?: string;
  /** Audio source. Default "silent" (anullsrc). Can also be an absolute file path. */
  audioSource?: AudioSource | string;
  /** Audio device identifier (platform-specific). For macOS avfoundation: device index. For Linux: pulse/alsa device name. */
  audioDevice?: string;
  /** Volume level 0–100. Default 80. Applied as FFmpeg audio filter. */
  volume?: number;
  /** Whether audio is muted. Default false. Overrides volume to 0 when true. */
  muted?: boolean;
}

class StreamManager {
  private ffmpeg: ChildProcess | null = null;
  private _running = false;
  private startedAt: number | null = null;
  private _frameCount = 0;
  /** Current stream config — stored for restart on volume/audio changes. */
  private _config: StreamConfig | null = null;
  /** Current volume level (0–100). */
  private _volume = 80;
  /** Whether audio is muted. */
  private _muted = false;
  /** Auto-restart state. */
  private _restartAttempts = 0;
  private _maxRestartAttempts = 5;
  private _restartDecayTimer: ReturnType<typeof setInterval> | null = null;
  private _intentionalStop = false;
  /** Pending auto-restart timer — cleared in stop() to prevent races. */
  private _restartTimer: ReturnType<typeof setTimeout> | null = null;
  /** Guard: prevents concurrent start() calls from orphaning FFmpeg. */
  private _starting = false;

  isRunning(): boolean {
    return this._running;
  }

  getUptime(): number {
    if (!this.startedAt) return 0;
    return Math.floor((Date.now() - this.startedAt) / 1000);
  }

  getHealth() {
    return {
      running: this._running,
      ffmpegAlive:
        this.ffmpeg !== null &&
        this.ffmpeg.exitCode === null &&
        !this.ffmpeg.killed,
      uptime: this.getUptime(),
      frameCount: this._frameCount,
      volume: this._volume,
      muted: this._muted,
      audioSource: this._config?.audioSource || "silent",
      inputMode: this._config?.inputMode || null,
    };
  }

  getVolume(): number {
    return this._muted ? 0 : this._volume;
  }

  isMuted(): boolean {
    return this._muted;
  }

  /**
   * Set volume (0–100). Restarts FFmpeg if currently streaming to apply the change.
   */
  async setVolume(level: number): Promise<void> {
    this._volume = Math.max(0, Math.min(100, Math.round(level)));
    logger.info(`${TAG} Volume set to ${this._volume}`);
    if (this._running && this._config) {
      await this.restart();
    }
  }

  /** Mute audio. Restarts FFmpeg if currently streaming. */
  async mute(): Promise<void> {
    if (this._muted) return;
    this._muted = true;
    logger.info(`${TAG} Audio muted`);
    if (this._running && this._config) {
      await this.restart();
    }
  }

  /** Unmute audio. Restarts FFmpeg if currently streaming. */
  async unmute(): Promise<void> {
    if (!this._muted) return;
    this._muted = false;
    logger.info(`${TAG} Audio unmuted (volume: ${this._volume})`);
    if (this._running && this._config) {
      await this.restart();
    }
  }

  /** Restart the stream with updated config (preserves uptime tracking). */
  private async restart(): Promise<void> {
    if (!this._config) return;
    const savedStartedAt = this.startedAt;
    const savedFrameCount = this._frameCount;

    // Detach TTS bridge before stopping FFmpeg
    ttsStreamBridge.detach();

    // Stop FFmpeg without resetting tracking
    if (this.ffmpeg && !this.ffmpeg.killed && this.ffmpeg.exitCode === null) {
      if (this.ffmpeg.stdin) {
        try {
          this.ffmpeg.stdin.end();
        } catch {
          /* ignore */
        }
      }
      this.ffmpeg.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => this.ffmpeg?.on("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      if (this.ffmpeg?.exitCode === null) {
        this.ffmpeg.kill("SIGKILL");
      }
    }
    this.ffmpeg = null;
    this._running = false;

    // Restart with current volume/mute applied
    const config = {
      ...this._config,
      volume: this._volume,
      muted: this._muted,
    };
    await this.start(config);

    // Restore tracking
    this.startedAt = savedStartedAt;
    this._frameCount = savedFrameCount;
    logger.info(
      `${TAG} Stream restarted (volume=${this._volume}, muted=${this._muted})`,
    );
  }

  /**
   * Write a JPEG frame to FFmpeg's stdin (only works in "pipe" mode).
   * Returns true if the frame was accepted.
   */
  writeFrame(jpegData: Buffer): boolean {
    if (!this._running || !this.ffmpeg || !this.ffmpeg.stdin) return false;
    if (this.ffmpeg.killed || this.ffmpeg.exitCode !== null) return false;

    try {
      this.ffmpeg.stdin.write(jpegData);
      this._frameCount++;
      if (this._frameCount % 150 === 0) {
        logger.info(`${TAG} Piped ${this._frameCount} frames to FFmpeg`);
      }
      return true;
    } catch {
      return false;
    }
  }

  async start(config: StreamConfig): Promise<void> {
    if (this._running || this._starting) {
      logger.warn(`${TAG} Already running or starting — stop first`);
      return;
    }
    this._starting = true;
    try {
      await this._startInner(config);
    } finally {
      this._starting = false;
    }
  }

  private async _startInner(config: StreamConfig): Promise<void> {
    // Pre-flight: ensure FFmpeg is installed
    try {
      execSync("ffmpeg -version", { stdio: "ignore", timeout: 5000 });
    } catch {
      const installHint =
        process.platform === "darwin"
          ? "Install with: brew install ffmpeg"
          : process.platform === "linux"
            ? "Install with: sudo apt install ffmpeg  (or your distro's package manager)"
            : "Download from https://ffmpeg.org/download.html";
      throw new Error(
        `FFmpeg not found. Streaming requires FFmpeg to be installed.\n${installHint}`,
      );
    }

    this._config = config;
    this._frameCount = 0;
    this._volume = config.volume ?? this._volume;
    this._muted = config.muted ?? this._muted;

    const resolution = config.resolution || "1280x720";
    const bitrate = config.bitrate || "2500k";
    const framerate = config.framerate || 15;
    const rtmpTarget = `${config.rtmpUrl}/${config.rtmpKey}`;
    const bufsize = `${parseInt(bitrate, 10) * 2}k`;
    const mode = config.inputMode || "testsrc";

    // Build FFmpeg args based on input mode
    const videoInputArgs = this.buildVideoInputArgs(
      config,
      resolution,
      framerate,
    );
    const audioInputArgs = this.buildAudioInputArgs(config);
    const isPipe = mode === "pipe";
    const isScreenCapture =
      mode === "avfoundation" || mode === "screen" || mode === "x11grab";

    // Effective volume: 0 when muted, otherwise 0–1.0 scale
    const effectiveVolume = this._muted ? 0 : this._volume / 100;

    // FFmpeg arg order: all inputs first, then filters, then encoding/output
    const ffmpegArgs = [
      "-thread_queue_size",
      "512",
      // Video input
      ...videoInputArgs,
      // Audio input
      ...audioInputArgs,
      // Video filter: scale for screen capture modes
      ...(isScreenCapture
        ? ["-vf", `scale=${resolution.replace("x", ":")}:flags=fast_bilinear`]
        : []),
      // Audio filter: volume control
      "-af",
      `volume=${effectiveVolume.toFixed(2)}`,
      // Video encoding (platform-specific)
      ...(process.platform === "darwin"
        ? [
            "-c:v",
            "h264_videotoolbox",
            "-realtime",
            "1",
            "-b:v",
            bitrate,
            "-maxrate",
            bitrate,
            "-bufsize",
            bufsize,
          ]
        : [
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-tune",
            "zerolatency",
            "-b:v",
            bitrate,
            "-maxrate",
            bitrate,
            "-bufsize",
            bufsize,
          ]),
      "-s",
      resolution,
      "-pix_fmt",
      "yuv420p",
      "-g",
      "60",
      // Audio encoding
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      // Output
      "-f",
      "flv",
      rtmpTarget,
    ];

    const audioSrc = config.audioSource || "silent";
    logger.info(
      `${TAG} Starting FFmpeg RTMP stream (video=${mode}, audio=${audioSrc}, vol=${this._volume}${this._muted ? " MUTED" : ""}) → ${config.rtmpUrl}`,
    );
    logger.info(
      `${TAG} Resolution: ${resolution}, Bitrate: ${bitrate}, FPS: ${framerate}`,
    );

    const isTts = (config.audioSource || "silent") === "tts";

    // In pipe mode, FFmpeg reads from stdin; otherwise stdin is ignored.
    // TTS mode adds a 4th stdio fd (pipe:3) for raw PCM audio input.
    this.ffmpeg = spawn("ffmpeg", ["-y", ...ffmpegArgs], {
      stdio: [
        isPipe ? "pipe" : "ignore",
        "pipe",
        "pipe",
        ...(isTts ? (["pipe"] as const) : []),
      ],
    });

    // Log all FFmpeg stderr for debugging
    this.ffmpeg.stderr?.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) {
        console.log(`[FFmpeg] ${line}`);
      }
    });

    this.ffmpeg.on("exit", (code, signal) => {
      if (this._running) {
        logger.warn(
          `${TAG} FFmpeg exited unexpectedly (code=${code}, signal=${signal})`,
        );
        this._running = false;
        if (!this._intentionalStop && this._config) {
          this.autoRestart();
        } else {
          this.startedAt = null;
        }
      }
    });

    // Handle stdin errors gracefully in pipe mode
    if (isPipe && this.ffmpeg.stdin) {
      this.ffmpeg.stdin.on("error", (err) => {
        logger.warn(`${TAG} FFmpeg stdin error: ${err.message}`);
      });
    }

    // Attach TTS bridge to pipe:3 for PCM audio
    if (isTts && this.ffmpeg.stdio[3]) {
      const pipe3 = this.ffmpeg.stdio[3] as import("node:stream").Writable;
      ttsStreamBridge.attach(pipe3);
      logger.info(`${TAG} TTS bridge attached to pipe:3`);
    }

    // Wait a moment to confirm it started
    await new Promise((r) => setTimeout(r, 1500));

    if (this.ffmpeg.exitCode !== null) {
      const exitCode = this.ffmpeg.exitCode;
      this.ffmpeg = null;
      throw new Error(`${TAG} FFmpeg exited immediately with code ${exitCode}`);
    }

    this._running = true;
    this.startedAt = Date.now();
    this._intentionalStop = false;
    // Decay restart counter every 30s of healthy running
    if (this._restartDecayTimer) clearInterval(this._restartDecayTimer);
    this._restartDecayTimer = setInterval(() => {
      if (this._restartAttempts > 0) {
        this._restartAttempts = Math.max(0, this._restartAttempts - 1);
        logger.info(
          `${TAG} Restart counter decayed to ${this._restartAttempts}`,
        );
      }
    }, 30_000);
    logger.info(`${TAG} FFmpeg streaming to RTMP — stream should be live`);
  }

  async stop(): Promise<{ uptime: number }> {
    const uptime = this.getUptime();
    const frames = this._frameCount;

    // Detach TTS bridge before killing FFmpeg
    ttsStreamBridge.detach();

    if (this.ffmpeg && !this.ffmpeg.killed && this.ffmpeg.exitCode === null) {
      const ffmpegProc = this.ffmpeg;
      // Close stdin first in pipe mode to signal EOF
      if (ffmpegProc.stdin) {
        try {
          ffmpegProc.stdin.end();
        } catch {
          /* ignore */
        }
      }
      ffmpegProc.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => ffmpegProc.on("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
      if (ffmpegProc.exitCode === null) {
        ffmpegProc.kill("SIGKILL");
      }
    }

    this._intentionalStop = true;
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    if (this._restartDecayTimer) {
      clearInterval(this._restartDecayTimer);
      this._restartDecayTimer = null;
    }
    this.ffmpeg = null;
    this._running = false;
    this.startedAt = null;
    this._frameCount = 0;
    this._restartAttempts = 0;
    this._config = null;
    logger.info(
      `${TAG} Stream stopped (uptime: ${uptime}s, frames: ${frames})`,
    );
    return { uptime };
  }

  /** Attempt to restart FFmpeg after unexpected exit with exponential backoff. */
  private autoRestart(): void {
    if (this._restartAttempts >= this._maxRestartAttempts) {
      logger.error(
        `${TAG} Max restart attempts (${this._maxRestartAttempts}) reached — giving up`,
      );
      this.startedAt = null;
      if (this._restartDecayTimer) {
        clearInterval(this._restartDecayTimer);
        this._restartDecayTimer = null;
      }
      return;
    }

    this._restartAttempts++;
    const delay = Math.min(1000 * 2 ** (this._restartAttempts - 1), 60_000);
    logger.info(
      `${TAG} Auto-restart attempt ${this._restartAttempts}/${this._maxRestartAttempts} in ${delay}ms`,
    );

    this._restartTimer = setTimeout(async () => {
      this._restartTimer = null;
      if (this._intentionalStop || !this._config) return;

      const savedStartedAt = this.startedAt;
      const savedFrameCount = this._frameCount;

      try {
        this.ffmpeg = null;
        await this.start({
          ...this._config,
          volume: this._volume,
          muted: this._muted,
        });
        // Restore tracking so uptime is continuous
        this.startedAt = savedStartedAt;
        this._frameCount = savedFrameCount;
        logger.info(`${TAG} Auto-restart successful`);
      } catch (err) {
        logger.error(
          `${TAG} Auto-restart failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        // start() failed before spawning FFmpeg — no exit event will fire,
        // so manually chain the next restart attempt if retries remain.
        if (!this._intentionalStop && this._config) {
          this.autoRestart();
        }
      }
    }, delay);
  }

  // ---------------------------------------------------------------------------
  // Video input args
  // ---------------------------------------------------------------------------

  private buildVideoInputArgs(
    config: StreamConfig,
    resolution: string,
    framerate: number,
  ): string[] {
    const mode = config.inputMode || "testsrc";

    switch (mode) {
      case "pipe": {
        // Read JPEG frames from stdin via image2pipe.
        // -c:v mjpeg is mandatory: image2pipe cannot auto-detect JPEG from piped data.
        // -probesize/-analyzeduration eliminate the default 5MB probe buffer that
        // causes FFmpeg to stall for ~100 frames before decoding starts.
        return [
          "-probesize",
          "32",
          "-analyzeduration",
          "0",
          "-f",
          "image2pipe",
          "-c:v",
          "mjpeg",
          "-framerate",
          String(framerate),
          "-i",
          "pipe:0",
        ];
      }
      case "avfoundation":
      case "screen": {
        // macOS native screen capture via avfoundation.
        // videoDevice "3" = Capture screen 0; ":none" = no audio from avfoundation.
        const videoDevice = config.videoDevice || "3";
        return [
          "-f",
          "avfoundation",
          "-framerate",
          String(framerate),
          "-pixel_format",
          "nv12",
          "-capture_cursor",
          "1",
          "-i",
          `${videoDevice}:none`,
        ];
      }
      case "x11grab": {
        // Linux virtual display capture (Xvfb) — the Hyperscape approach.
        // Requires: Xvfb :99 -screen 0 1280x720x24 -ac &
        // Then run a browser/TUI on display :99.
        const display = config.display || ":99";
        return [
          "-f",
          "x11grab",
          "-video_size",
          resolution,
          "-framerate",
          String(framerate),
          "-draw_mouse",
          "0",
          "-i",
          display,
        ];
      }
      case "file": {
        // Read from a continuously-updated JPEG file (written by browser-capture).
        const framePath = config.frameFile || "/tmp/milady-stream-frame.jpg";
        return [
          "-probesize",
          "32",
          "-analyzeduration",
          "0",
          "-loop",
          "1",
          "-f",
          "image2",
          "-c:v",
          "mjpeg",
          "-framerate",
          String(framerate),
          "-i",
          framePath,
        ];
      }
      default: {
        // Solid color test pattern (dark navy)
        return [
          "-f",
          "lavfi",
          "-i",
          `color=c=0x1a1a2e:s=${resolution}:r=${framerate}`,
        ];
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Audio input args
  // ---------------------------------------------------------------------------

  private buildAudioInputArgs(config: StreamConfig): string[] {
    const source = config.audioSource || "silent";

    switch (source) {
      case "tts": {
        // Raw PCM from TTS bridge via pipe:3 (4th stdio fd).
        // Format must match tts-stream-bridge output: s16le, 24kHz, mono.
        // -use_wallclock_as_timestamps 1: raw PCM has no timestamps, so FFmpeg
        //   uses wall-clock time to sync with the video stream.
        // -probesize/-analyzeduration: eliminate probe buffering for immediate start.
        // -thread_queue_size: prevent queue overflow from high-frequency tick writes.
        return [
          "-use_wallclock_as_timestamps",
          "1",
          "-probesize",
          "32",
          "-analyzeduration",
          "0",
          "-thread_queue_size",
          "512",
          "-f",
          "s16le",
          "-ar",
          "24000",
          "-ac",
          "1",
          "-i",
          "pipe:3",
        ];
      }
      case "silent": {
        // Synthetic silent audio — always works, no hardware required.
        return [
          "-f",
          "lavfi",
          "-i",
          "anullsrc=channel_layout=stereo:sample_rate=44100",
        ];
      }
      case "system": {
        // System/desktop audio capture.
        if (process.platform === "darwin") {
          // macOS: requires BlackHole or similar virtual audio device.
          // audioDevice is the avfoundation audio device index (e.g., "2").
          const device = config.audioDevice || "0";
          return ["-f", "avfoundation", "-i", `none:${device}`];
        }
        // Linux: PulseAudio monitor source captures desktop audio.
        const device = config.audioDevice || "default";
        return ["-f", "pulse", "-i", device];
      }
      case "microphone": {
        // Microphone input.
        if (process.platform === "darwin") {
          const device = config.audioDevice || "0";
          return ["-f", "avfoundation", "-i", `none:${device}`];
        }
        const device = config.audioDevice || "default";
        return ["-f", "pulse", "-i", device];
      }
      default: {
        // Treat as a file path — play audio file as stream audio.
        // Supports mp3, wav, ogg, flac, etc.
        if (source.startsWith("/") || source.startsWith("./")) {
          return ["-stream_loop", "-1", "-i", source];
        }
        // Fallback to silent if source is unrecognized.
        return [
          "-f",
          "lavfi",
          "-i",
          "anullsrc=channel_layout=stereo:sample_rate=44100",
        ];
      }
    }
  }

  /** Get the TTS stream bridge for external speak triggers. */
  getTtsBridge(): ITtsStreamBridge {
    return ttsStreamBridge;
  }
}

// Module singleton
export const streamManager = new StreamManager();
