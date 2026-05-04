declare module "pty-state-capture" {
  export type StreamDirection = "stdout" | "stderr" | "stdin";
  export type CaptureLifecycleEvent =
    | "session_started"
    | "session_ready"
    | "session_stopped"
    | "session_error";

  export interface FeedOutputResult {
    stateChanged: boolean;
    state: unknown;
    transition?: unknown;
    frame: unknown;
    normalizedChunk: string;
  }

  export interface SessionCaptureSnapshot {
    sessionId: string;
    paths: unknown;
    frame: unknown;
    normalizedTail: string;
    state: unknown;
    transitions: number;
  }

  export interface SessionCaptureOptions {
    sessionId: string;
    outputDir: string;
    source?: string;
    stateRules?: unknown[];
    writeRawEvents?: boolean;
    writeStates?: boolean;
    writeTransitions?: boolean;
    writeLifecycle?: boolean;
    maxNormalizedBufferChars?: number;
    rows?: number;
    cols?: number;
    maxLines?: number;
  }

  export interface CaptureManagerOptions {
    outputRootDir: string;
    defaultRows?: number;
    defaultCols?: number;
    maxLines?: number;
    maxNormalizedBufferChars?: number;
  }

  export interface SessionStateCapture {
    recordLifecycle(
      event: CaptureLifecycleEvent,
      detail?: string,
    ): Promise<void>;
    feed(chunk: string, direction?: StreamDirection): Promise<FeedOutputResult>;
    snapshot(): SessionCaptureSnapshot;
    getCurrentState(): string;
  }

  export class PTYStateCaptureManager {
    constructor(options: CaptureManagerOptions);
    openSession(
      sessionId: string,
      overrides?: Partial<SessionCaptureOptions>,
    ): Promise<SessionStateCapture>;
    feed(
      sessionId: string,
      chunk: string,
      direction?: StreamDirection,
    ): Promise<FeedOutputResult>;
    lifecycle(
      sessionId: string,
      event: CaptureLifecycleEvent,
      detail?: string,
    ): Promise<void>;
    snapshot(sessionId: string): SessionCaptureSnapshot | null;
    listSessions(): string[];
  }
}
