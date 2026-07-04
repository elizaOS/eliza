/**
 * `StreamRouteState` — the shared state bundle the consuming runtime passes into
 * `handleStreamRoute`. Carries the `StreamManager` reference, the destinations
 * map, and the optional `IScreenCaptureService` used to source desktop frames,
 * so the route handler stays a pure function of its inputs.
 */
import type { IScreenCaptureService } from "@elizaos/core";
import type { StreamingDestination } from "./streaming-types.js";

export interface StreamRouteState {
  streamManager: {
    isRunning(): boolean;
    writeFrame(buf: Buffer): boolean;
    start(config: unknown): Promise<void>;
    stop(): Promise<{ uptime: number }>;
    getHealth(): {
      running: boolean;
      ffmpegAlive: boolean;
      uptime: number;
      frameCount: number;
      volume: number;
      muted: boolean;
      audioSource: string;
      inputMode: string | null;
    };
    getVolume(): number;
    isMuted(): boolean;
    setVolume(level: number): Promise<void>;
    mute(): Promise<void>;
    unmute(): Promise<void>;
  };
  port?: number;
  captureUrl?: string;
  screenCapture?: IScreenCaptureService;
  destinations: Map<string, StreamingDestination>;
  activeDestinationId?: string;
  activeStreamSource: {
    type: "stream-tab" | "game" | "custom-url";
    url?: string;
  };
  config?: {
    messages?: {
      tts?: Record<string, unknown>;
    };
  };
  /**
   * When the client saves stream visual settings, mirror `avatarIndex` into
   * Eliza `config.ui` (and live server state). Greeting + identity read
   * `config.ui`, while avatar taps only hit `/api/stream/settings` today.
   */
  mirrorStreamAvatarToElizaConfig?: (avatarIndex: number) => void;
}
