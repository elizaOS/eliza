/**
 * Client half of the desktop local-agent NDJSON stdio bridge (#12180 / #12355).
 *
 * The agent child, booted in `localAgentMode` (no TCP listener), speaks the
 * platform-neutral NDJSON frame protocol on its stdio pipe — the same framing
 * `createStdioBridge` (the server kernel in `@elizaos/plugin-capacitor-bridge`)
 * writes back. This module is the main-process peer: it serializes a normalized
 * local-agent request into a request frame, writes the line to the child's
 * stdin, and resolves when the matching response frame arrives on stdout. It
 * owns request/response correlation (monotonic ids), cancellation, and the
 * error-frame-to-rejection translation, so a failed dispatch surfaces as a
 * thrown RPC error rather than a fabricated 200.
 *
 * Buffered request/response only — the streaming leg
 * (`localAgentStreamRequest`) is added with its child-side consumer.
 */

import { Buffer } from "node:buffer";
import type {
  LocalAgentDispatcher,
  NormalizedLocalAgentRequest,
} from "./local-agent-request";
import type { LocalAgentRequestResult } from "./rpc-schema";

/** Method label the child dispatches to its in-process route kernel. */
const LOCAL_AGENT_REQUEST_METHOD = "local_agent_request" as const;

/** Sink for outbound request frames — the child process's stdin writer. */
export interface StdioFrameWriter {
  write(line: string): void;
}

interface PendingRequest {
  ownerRequestId: string;
  resolve: (result: LocalAgentRequestResult) => void;
  reject: (error: Error) => void;
}

interface PendingStream {
  resolveHead: (result: {
    streamId: string;
    status: number;
    statusText?: string;
    headers?: Record<string, string>;
  }) => void;
  rejectHead: (error: Error) => void;
  onChunk: (chunk: string) => void;
  onEnd: (error?: string) => void;
  headSettled: boolean;
}

interface StdioResponseFrame {
  id?: unknown;
  ok?: unknown;
  result?: unknown;
  error?: unknown;
  stream?: unknown;
  status?: unknown;
  statusText?: unknown;
  headers?: unknown;
  dataBase64?: unknown;
}

function isLocalAgentRequestResult(
  value: unknown,
): value is LocalAgentRequestResult {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { status?: unknown }).status === "number"
  );
}

/**
 * Buffered stdio-bridge dispatcher. Construct one per agent child with a writer
 * bound to the child's stdin; feed every stdout line to {@link handleLine}. The
 * child correlates responses by echoing the request `id`.
 */
export class LocalAgentStdioDispatcher implements LocalAgentDispatcher {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly pendingStreams = new Map<string, PendingStream>();

  constructor(private readonly writer: StdioFrameWriter) {}

  request(
    request: NormalizedLocalAgentRequest,
  ): Promise<LocalAgentRequestResult> {
    const id = this.nextId++;
    return new Promise<LocalAgentRequestResult>((resolve, reject) => {
      this.pending.set(id, {
        ownerRequestId: request.requestId,
        resolve,
        reject,
      });

      const frame = JSON.stringify({
        id,
        method: LOCAL_AGENT_REQUEST_METHOD,
        payload: {
          path: request.path,
          method: request.method,
          headers: request.headers,
          body: request.body,
        },
      });
      try {
        this.writer.write(`${frame}\n`);
      } catch (err) {
        this.settleError(
          id,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    });
  }

  cancel(ownerRequestId: string): boolean {
    const entry = [...this.pending.entries()].find(
      ([, pending]) => pending.ownerRequestId === ownerRequestId,
    );
    const stream = this.pendingStreams.get(ownerRequestId);
    const requestId = entry?.[0] ?? (stream ? ownerRequestId : null);
    if (requestId === null) return false;
    const controlId = this.nextId++;
    this.writer.write(
      `${JSON.stringify({
        id: controlId,
        method: "local_agent_cancel",
        payload: { requestId },
      })}\n`,
    );
    return true;
  }

  requestStream(
    request: NormalizedLocalAgentRequest,
    callbacks: {
      onChunk: (chunk: string) => void;
      onEnd: (error?: string) => void;
    },
  ): Promise<{
    streamId: string;
    status: number;
    statusText?: string;
    headers?: Record<string, string>;
  }> {
    const streamId = request.requestId;
    if (this.pendingStreams.has(streamId)) {
      return Promise.reject(
        new Error(`Duplicate local-agent stream id: ${streamId}`),
      );
    }
    return new Promise((resolveHead, rejectHead) => {
      this.pendingStreams.set(streamId, {
        resolveHead,
        rejectHead,
        onChunk: callbacks.onChunk,
        onEnd: callbacks.onEnd,
        headSettled: false,
      });
      try {
        this.writer.write(
          `${JSON.stringify({
            id: streamId,
            method: "local_agent_stream_request",
            stream: true,
            payload: {
              path: request.path,
              method: request.method,
              headers: request.headers,
              body: request.body,
            },
          })}\n`,
        );
      } catch (error) {
        this.pendingStreams.delete(streamId);
        rejectHead(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Feed one raw stdout line from the child. Non-JSON lines and frames without a
   * numeric id we are waiting on are ignored (the child multiplexes logs on the
   * same pipe). A matched frame settles its pending request.
   */
  handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let frame: StdioResponseFrame;
    try {
      frame = JSON.parse(trimmed) as StdioResponseFrame;
    } catch {
      return;
    }
    if (typeof frame.id === "string" && typeof frame.stream === "string") {
      this.handleStreamFrame(frame.id, frame);
      return;
    }
    if (typeof frame.id !== "number") return;
    const pending = this.pending.get(frame.id);
    if (!pending) return;

    if (frame.ok === false) {
      this.settleError(
        frame.id,
        new Error(
          typeof frame.error === "string"
            ? frame.error
            : "localAgentRequest failed.",
        ),
      );
      return;
    }
    if (!isLocalAgentRequestResult(frame.result)) {
      this.settleError(
        frame.id,
        new Error("localAgentRequest response frame missing a numeric status."),
      );
      return;
    }
    this.settleResult(frame.id, frame.result);
  }

  /** Reject every in-flight request — call when the child stdio pipe closes. */
  dispose(reason: string): void {
    for (const id of [...this.pending.keys()]) {
      this.settleError(id, new Error(reason));
    }
    for (const [streamId, pending] of this.pendingStreams) {
      const error = new Error(reason);
      if (!pending.headSettled) pending.rejectHead(error);
      else pending.onEnd(error.message);
      this.pendingStreams.delete(streamId);
    }
  }

  private handleStreamFrame(streamId: string, frame: StdioResponseFrame): void {
    const pending = this.pendingStreams.get(streamId);
    if (!pending) return;
    if (frame.stream === "response") {
      if (pending.headSettled || typeof frame.status !== "number") return;
      pending.headSettled = true;
      pending.resolveHead({
        streamId,
        status: frame.status,
        ...(typeof frame.statusText === "string"
          ? { statusText: frame.statusText }
          : {}),
        ...(frame.headers && typeof frame.headers === "object"
          ? { headers: frame.headers as Record<string, string> }
          : {}),
      });
      return;
    }
    if (frame.stream === "chunk" && typeof frame.dataBase64 === "string") {
      pending.onChunk(Buffer.from(frame.dataBase64, "base64").toString("utf8"));
      return;
    }
    if (frame.stream !== "complete") return;
    this.pendingStreams.delete(streamId);
    const error = typeof frame.error === "string" ? frame.error : undefined;
    if (!pending.headSettled && error) {
      pending.rejectHead(new Error(error));
      return;
    }
    if (!pending.headSettled) {
      pending.headSettled = true;
      pending.resolveHead({ streamId, status: 200 });
    }
    pending.onEnd(error);
  }

  private settleResult(id: number, result: LocalAgentRequestResult): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.resolve(result);
  }

  private settleError(id: number, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.reject(error);
  }
}
