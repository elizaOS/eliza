/**
 * Platform-neutral NDJSON-over-stdio bridge kernel (#12180).
 *
 * The iOS local agent already reaches its in-process runtime over a sealed
 * stdio pipe: the native host writes newline-delimited JSON request frames to
 * the bridge's stdin and reads response frames from stdout, with no TCP port
 * (`inProcess: true`, `isAuthorized: () => true`). This module extracts the
 * reusable half of that loop — the line reader, JSON frame parse, request
 * dispatch, and response serialization — so iOS today and a future Android /
 * desktop stdio bridge can all construct one from the same code instead of each
 * re-implementing the buffering + framing.
 *
 * This slice is BUFFERED ONLY. `requestStream` is accepted so callers can wire
 * it once the device-side streaming contract exists, but no streaming frame
 * protocol is implemented here yet — the default throws a clear error.
 *
 * The kernel deliberately owns NO transport trust, runtime boot, host-call
 * re-entrancy, or stdout reservation — those stay platform-specific. It is a
 * pure line/frame codec around a request handler.
 */

/** A single inbound request frame: `{ id?, method?, payload? }`. */
export interface StdioBridgeRequestFrame {
  id?: unknown;
  method?: unknown;
  payload?: unknown;
}

/** A single outbound response frame written back per request. */
export interface StdioBridgeResponseFrame {
  id: unknown;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Handles one parsed request frame and resolves its result payload. Throwing
 * (or rejecting) is surfaced to the peer as `{ ok: false, error }` — the kernel
 * never swallows a handler failure into a success frame.
 */
export type StdioBridgeRequestHandler = (
  request: StdioBridgeRequestFrame,
) => Promise<unknown>;

/**
 * Streaming request handler. Not implemented in this slice (buffered only); the
 * device-side streaming contract (#12180 item 5/6) will supply a real one.
 */
export type StdioBridgeStreamHandler = (
  request: StdioBridgeRequestFrame,
) => Promise<void>;

export interface CreateStdioBridgeOptions {
  /** Buffered request/response handler. Required. */
  request: StdioBridgeRequestHandler;
  /** Streaming handler. Optional; defaults to a clear not-implemented throw. */
  requestStream?: StdioBridgeStreamHandler;
  /**
   * Writes one outbound frame to the peer. The caller owns the actual transport
   * (which stdout FD, whether stdout is reserved for the protocol, etc.).
   */
  writeFrame: (frame: StdioBridgeResponseFrame) => void;
  /**
   * Optional pre-dispatch hook consulted per input line. Return `true` to claim
   * the line so the kernel skips request dispatch for it — used by iOS to route
   * host-call result frames that share the same stdin pipe. Defaults to never
   * claiming.
   */
  interceptLine?: (line: string) => boolean;
}

export interface StdioBridge {
  /**
   * Feed one raw input line. Blank lines are ignored. Lines claimed by
   * `interceptLine` are not dispatched. Otherwise the line is parsed as a JSON
   * request frame and dispatched; a response frame is always written (parse
   * errors and handler failures included).
   */
  handleLine: (line: string) => Promise<void>;
  /**
   * Serialized tail of all in-flight `handleLine` dispatches — await before
   * teardown so no response is dropped.
   */
  drain: () => Promise<void>;
  requestStream: StdioBridgeStreamHandler;
}

const defaultRequestStream: StdioBridgeStreamHandler = () => {
  return Promise.reject(
    new Error(
      "stdio bridge streaming (http_request_stream) is not implemented in this build; use buffered request",
    ),
  );
};

/**
 * Construct a buffered NDJSON stdio bridge around a request handler. The caller
 * drives it by feeding input lines (from its own stdin reader) and supplies the
 * frame writer; the kernel handles JSON framing, per-line dispatch ordering, and
 * error-to-frame translation.
 */
export function createStdioBridge(
  options: CreateStdioBridgeOptions,
): StdioBridge {
  const { request, writeFrame, interceptLine } = options;
  const requestStream = options.requestStream ?? defaultRequestStream;

  const writeError = (id: unknown, err: unknown): void => {
    writeFrame({
      id: id ?? null,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  };

  const dispatchLine = async (line: string): Promise<void> => {
    if (!line.trim()) return;

    let parsed: StdioBridgeRequestFrame;
    try {
      parsed = JSON.parse(line) as StdioBridgeRequestFrame;
    } catch (err) {
      writeError(null, err);
      return;
    }

    const id = parsed.id ?? null;
    try {
      const result = await request(parsed);
      writeFrame({ id, ok: true, result });
    } catch (err) {
      writeError(id, err);
    }
  };

  // Serialize dispatches so responses are written in request order and teardown
  // can await the tail. A single failing dispatch never breaks the chain.
  let pending: Promise<void> = Promise.resolve();

  const handleLine = (line: string): Promise<void> => {
    if (interceptLine?.(line)) return Promise.resolve();
    const next = pending
      .then(() => dispatchLine(line))
      .catch((err) => {
        writeError(null, err);
      });
    pending = next;
    return next;
  };

  return {
    handleLine,
    drain: () => pending.catch(() => undefined),
    requestStream,
  };
}
