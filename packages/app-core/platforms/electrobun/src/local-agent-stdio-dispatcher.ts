/**
 * Client half of the desktop local-agent NDJSON stdio bridge (#12180 / #12355).
 *
 * The agent child, booted in `localAgentMode` (no TCP listener), speaks the
 * platform-neutral NDJSON frame protocol on its stdio pipe — the same framing
 * `createStdioBridge` (the server kernel in `@elizaos/plugin-capacitor-bridge`)
 * writes back. This module is the main-process peer: it serializes a normalized
 * local-agent request into a request frame, writes the line to the child's
 * stdin, and resolves when the matching response frame arrives on stdout. It
 * owns request/response correlation (monotonic ids), timeout, and the
 * error-frame-to-rejection translation, so a failed dispatch surfaces as a
 * thrown RPC error rather than a fabricated 200.
 *
 * Buffered request/response only — the streaming leg
 * (`localAgentStreamRequest`) is added with its child-side consumer.
 */

import type {
  LocalAgentDispatcher,
  NormalizedLocalAgentRequest,
} from "./local-agent-request";
import type { LocalAgentRequestResult } from "./rpc-schema";

/** Method label the child dispatches to its in-process route kernel. */
const LOCAL_AGENT_REQUEST_METHOD = "local_agent_request" as const;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Sink for outbound request frames — the child process's stdin writer. */
export interface StdioFrameWriter {
  write(line: string): void;
}

interface PendingRequest {
  resolve: (result: LocalAgentRequestResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface StdioResponseFrame {
  id?: unknown;
  ok?: unknown;
  result?: unknown;
  error?: unknown;
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

  constructor(
    private readonly writer: StdioFrameWriter,
    private readonly defaultTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {}

  request(
    request: NormalizedLocalAgentRequest,
  ): Promise<LocalAgentRequestResult> {
    const id = this.nextId++;
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    return new Promise<LocalAgentRequestResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `localAgentRequest ${request.method} ${request.path} timed out after ${timeoutMs}ms.`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });

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
  }

  private settleResult(id: number, result: LocalAgentRequestResult): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve(result);
  }

  private settleError(id: number, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.reject(error);
  }
}
