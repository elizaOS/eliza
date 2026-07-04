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
 * Supports both buffered request/response and incremental streaming: a frame
 * whose `stream === true` is routed to the optional `requestStream` handler,
 * which pushes `{ id, stream: "response" | "chunk" | "complete" }` frames as the
 * body arrives (the Android WebView maps these onto `agentStream*` Capacitor
 * events). Buffered frames still get one terminal `{ ok, result }`.
 *
 * The kernel deliberately owns NO transport trust, runtime boot, host-call
 * re-entrancy, or stdout reservation — those stay platform-specific. It is a
 * pure line/frame codec around a request handler.
 */

/** A single inbound request frame: `{ id?, method?, payload?, stream? }`. */
export interface StdioBridgeRequestFrame {
	id?: unknown;
	method?: unknown;
	payload?: unknown;
	/** When `true`, dispatch to the streaming handler and emit stream frames. */
	stream?: unknown;
}

/** A single outbound frame written back to the peer. */
export interface StdioBridgeResponseFrame {
	id: unknown;
	/** Buffered terminal outcome. Absent on streaming frames. */
	ok?: boolean;
	result?: unknown;
	error?: string;
	/**
	 * Stream phase for an incremental response: `"response"` (head), `"chunk"`
	 * (one body fragment), or `"complete"` (terminal). Absent on buffered frames.
	 */
	stream?: "response" | "chunk" | "complete";
	/** Response status — carried on the `"response"` head frame. */
	status?: number;
	statusText?: string;
	/** Response headers — carried on the `"response"` head frame. */
	headers?: Record<string, string>;
	/** Base64 body fragment — carried on each `"chunk"` frame. */
	dataBase64?: string;
}

/**
 * Handles one parsed buffered request frame and resolves its result payload.
 * Throwing (or rejecting) is surfaced to the peer as `{ ok: false, error }` —
 * the kernel never swallows a handler failure into a success frame.
 */
export type StdioBridgeRequestHandler = (
	request: StdioBridgeRequestFrame,
) => Promise<unknown>;

/** The head of a streaming response, emitted once before any chunk. */
export interface StdioBridgeStreamHead {
	status: number;
	statusText: string;
	headers: Record<string, string>;
}

/**
 * Sink a streaming handler drives to push a response head, body chunks, and a
 * terminal completion. `emitError` and `emitComplete` are mutually terminal.
 */
export interface StdioBridgeStreamSink {
	emitResponse: (head: StdioBridgeStreamHead) => void;
	emitChunk: (dataBase64: string) => void;
	emitComplete: () => void;
	emitError: (message: string) => void;
}

/**
 * Handles one parsed streaming request frame by driving `sink`. A throw/reject
 * before the sink is completed is surfaced as a terminal stream error frame.
 */
export type StdioBridgeStreamHandler = (
	request: StdioBridgeRequestFrame,
	sink: StdioBridgeStreamSink,
) => Promise<void>;

export interface CreateStdioBridgeOptions {
	/** Buffered request/response handler. Required. */
	request: StdioBridgeRequestHandler;
	/**
	 * Optional incremental streaming handler. When a frame arrives with
	 * `stream === true` and this is set, the kernel routes to it and emits
	 * `stream` frames. Without it, a streaming frame falls back to the buffered
	 * `request` handler (one terminal result).
	 */
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
}

/**
 * Construct a buffered NDJSON stdio bridge around a request handler. The caller
 * drives it by feeding input lines (from its own stdin reader) and supplies the
 * frame writer; the kernel handles JSON framing, per-line dispatch ordering, and
 * error-to-frame translation.
 */
export function createStdioBridge(
	options: CreateStdioBridgeOptions,
): StdioBridge {
	const { request, requestStream, writeFrame, interceptLine } = options;

	const writeError = (id: unknown, err: unknown): void => {
		writeFrame({
			id: id ?? null,
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		});
	};

	const dispatchStream = async (
		id: unknown,
		parsed: StdioBridgeRequestFrame,
		handler: StdioBridgeStreamHandler,
	): Promise<void> => {
		// One-shot terminal guard: the head/chunk/complete/error frames are a
		// single ordered lifecycle, and a handler that both completes and throws
		// (or emits after completing) must not double-terminate the peer's stream.
		let terminated = false;
		const sink: StdioBridgeStreamSink = {
			emitResponse: (head) => {
				if (terminated) return;
				writeFrame({
					id,
					stream: "response",
					status: head.status,
					statusText: head.statusText,
					headers: head.headers,
				});
			},
			emitChunk: (dataBase64) => {
				if (terminated) return;
				writeFrame({ id, stream: "chunk", dataBase64 });
			},
			emitComplete: () => {
				if (terminated) return;
				terminated = true;
				writeFrame({ id, stream: "complete" });
			},
			emitError: (message) => {
				if (terminated) return;
				terminated = true;
				writeFrame({ id, stream: "complete", error: message });
			},
		};
		try {
			await handler(parsed, sink);
			sink.emitComplete();
		} catch (err) {
			sink.emitError(err instanceof Error ? err.message : String(err));
		}
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
		if (parsed.stream === true && requestStream) {
			await dispatchStream(id, parsed, requestStream);
			return;
		}
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
	};
}
