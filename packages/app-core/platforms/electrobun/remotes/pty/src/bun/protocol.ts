/** Implements Electrobun PTY remote protocol ts boundaries for desktop app-core. */
export const TERMINAL_REMOTE_ID = "eliza.pty" as const;

export type PtySessionId = string;

export type PtyErrorCode =
  | "PTY_SESSION_NOT_FOUND"
  | "PTY_SESSION_ALREADY_EXITED"
  | "PTY_CREATE_FAILED"
  | "PTY_WRITE_FAILED"
  | "PTY_RESIZE_FAILED"
  | "PTY_KILL_FAILED"
  | "PTY_REQUEST_FAILED"
  | "PTY_UNKNOWN";

export type PtyError = {
  code: PtyErrorCode;
  message: string;
  sessionId?: PtySessionId;
  details?: unknown;
};

export type PtySessionStatus =
  | "starting"
  | "running"
  | "exited"
  | "killed"
  | "error";

export type PtySession = {
  id: PtySessionId;
  command: string;
  args: string[];
  cwd: string;
  status: PtySessionStatus;
  pid?: number;
  shell?: string;
  exitCode?: number | null;
  signal?: string | null;
  createdAt: string;
  updatedAt: string;
  exitedAt?: string;
  error?: string;
};

export type PtyCreateSessionParams = {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  name?: string;
};

export type PtyCreateSessionResult = {
  session: PtySession;
};

export type PtyWriteParams = {
  sessionId: PtySessionId;
  data: string;
};

export type PtyResizeParams = {
  sessionId: PtySessionId;
  cols: number;
  rows: number;
};

export type PtyKillParams = {
  sessionId: PtySessionId;
  signal?: string;
};

export type PtyOutputEntry = {
  sessionId: PtySessionId;
  sequence: number;
  data: string;
  timestamp: string;
};

export type PtyOutputTailParams = {
  sessionId: PtySessionId;
  afterSequence?: number;
  limit?: number;
};

export type PtyOutputTailResult = {
  sessionId: PtySessionId;
  entries: PtyOutputEntry[];
  nextSequence: number;
};

export type PtyCommandRunParams = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
};

export type PtyCommandRunResult = {
  session: PtySession;
  output: string;
  exitCode: number | null;
  timedOut: boolean;
};

export type PtyStatus = {
  id: "eliza.pty";
  ok: true;
  implementation: "bun-terminal";
  truePty: true;
  activeSessions: number;
  totalSessions: number;
  limits: {
    maxSessions: number;
    maxOutputEntries: number;
    maxOutputBytes: number;
    commandTimeoutMs: number;
  };
};

export type PtyMethod =
  | "pty.status"
  | "pty.session.create"
  | "pty.session.list"
  | "pty.session.get"
  | "pty.session.write"
  | "pty.session.resize"
  | "pty.session.kill"
  | "pty.session.output.tail"
  | "pty.session.output.clear"
  | "pty.command.run";

export type PtyEventName =
  | "pty.session.created"
  | "pty.output"
  | "pty.session.exited"
  | "pty.session.killed"
  | "pty.error";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | { [key: string]: JsonValue }
  | JsonValue[];

export type PtyWorkerRequestMessage = {
  type: "request";
  requestId: string | number;
  method: PtyMethod;
  params?: JsonValue;
};

export type PtyResponsePayload =
  | PtyStatus
  | PtyCreateSessionResult
  | PtySession
  | PtySession[]
  | PtyOutputTailResult
  | PtyCommandRunResult
  | { ok: true };

export type PtyWorkerResponseMessage =
  | {
      type: "response";
      requestId: string | number;
      success: true;
      payload: PtyResponsePayload;
    }
  | {
      type: "response";
      requestId: string | number;
      success: false;
      error: PtyError;
    };

export type PtyWorkerReadyMessage = {
  type: "ready";
};

export type PtyWorkerEventMessage = {
  type: "event";
  name: PtyEventName;
  payload: PtySession | PtyOutputEntry | PtyError;
};

export type PtyWorkerOutboundMessage =
  | PtyWorkerResponseMessage
  | PtyWorkerReadyMessage
  | PtyWorkerEventMessage;
