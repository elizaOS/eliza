/** Validates native commands and admits complete messages within Chromium's native-message limit. */
export const MAX_NATIVE_BYTES = 48 * 1024;
export class BridgeError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.kind = kind;
  }
}
export function serializeCompleteMessage(value: unknown) {
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).byteLength > MAX_NATIVE_BYTES)
    throw new BridgeError(
      "PAYLOAD_TOO_LARGE",
      "Complete browser result exceeds the native transport limit; request an explicit element selector or narrower operation.",
    );
  return value;
}
const actions = new Set([
  "list",
  "open",
  "navigate",
  "snapshot",
  "click",
  "fill",
  "scroll",
  "back",
  "forward",
  "reload",
  "close",
]);
export function parseCommand(input: unknown) {
  const value = input as {
    type?: unknown;
    id?: unknown;
    command?: Record<string, unknown>;
  } | null;
  if (
    !value ||
    typeof value !== "object" ||
    value.type !== "command" ||
    typeof value.id !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(value.id)
  )
    throw new BridgeError(
      "INVALID_REQUEST",
      "Native request identity is invalid.",
    );
  const command = value.command;
  if (
    !command ||
    typeof command !== "object" ||
    !actions.has(String(command.subaction))
  )
    throw new BridgeError("UNSUPPORTED", "Unsupported typed browser command.");
  if (
    !["list", "open"].includes(String(command.subaction)) &&
    (typeof command.id !== "string" ||
      !/^\d+$/.test(command.id) ||
      !Number.isSafeInteger(Number(command.id)))
  )
    throw new BridgeError(
      "INVALID_REQUEST",
      "An explicit Chromium tab ID is required.",
    );
  if (["open", "navigate"].includes(String(command.subaction))) {
    let url: URL;
    try {
      url = new URL(String(command.url));
    } catch {
      throw new BridgeError(
        "INVALID_REQUEST",
        "Navigation requires a valid HTTP(S) URL.",
      );
    }
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new BridgeError(
        "POLICY_BLOCKED",
        "Navigation requires HTTP(S) without embedded credentials.",
      );
  }
  if (
    ["click", "fill", "scroll"].includes(String(command.subaction)) &&
    typeof command.selector !== "string"
  )
    throw new BridgeError(
      "INVALID_REQUEST",
      "Use an element selector from the latest snapshot.",
    );
  if (command.subaction === "fill" && typeof command.text !== "string")
    throw new BridgeError("INVALID_REQUEST", "Fill requires a text string.");
  return { id: value.id, command };
}

export function encodeNativeMessage(message: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(message));
  if (bytes.byteLength <= MAX_NATIVE_BYTES) return [message];
  const id = crypto.randomUUID();
  const count = Math.ceil(bytes.byteLength / (16 * 1024));
  const frames = [];
  for (let index = 0; index < count; index++) {
    const part = bytes.subarray(index * 16 * 1024, (index + 1) * 16 * 1024);
    let binary = "";
    for (const byte of part) binary += String.fromCharCode(byte);
    frames.push({ type: "chunk", id, index, count, data: btoa(binary) });
  }
  return frames;
}

export class NativeMessageAssembler {
  private pending = new Map<
    string,
    { count: number; parts: Uint8Array[]; length: number }
  >();
  accept(input: unknown): unknown {
    serializeCompleteMessage(input);
    const frame = input as {
      type?: unknown;
      id: string;
      index: number;
      count: number;
      data: string;
    };
    if (frame?.type !== "chunk") return input;
    if (
      typeof frame.id !== "string" ||
      !Number.isSafeInteger(frame.index) ||
      !Number.isSafeInteger(frame.count) ||
      frame.count < 1 ||
      frame.index < 0 ||
      frame.index >= frame.count ||
      typeof frame.data !== "string"
    )
      throw new BridgeError("INVALID_REQUEST", "Invalid native chunk framing.");
    let transfer = this.pending.get(frame.id);
    if (!transfer) {
      if (frame.index !== 0)
        throw new BridgeError(
          "INVALID_REQUEST",
          "Native chunks must start at zero.",
        );
      transfer = { count: frame.count, parts: [], length: 0 };
      this.pending.set(frame.id, transfer);
    }
    if (
      transfer.count !== frame.count ||
      transfer.parts.length !== frame.index
    ) {
      this.pending.delete(frame.id);
      throw new BridgeError(
        "INVALID_REQUEST",
        "Native chunks arrived out of order.",
      );
    }
    const part = Uint8Array.from(atob(frame.data), (value) =>
      value.charCodeAt(0),
    );
    transfer.parts.push(part);
    transfer.length += part.length;
    if (transfer.parts.length !== transfer.count) return null;
    this.pending.delete(frame.id);
    const bytes = new Uint8Array(transfer.length);
    let offset = 0;
    for (const part of transfer.parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }
}

/** Stops one-way Binder queues from exhausting their shared buffer. Acknowledgements
 * confirm receipt of a chunk only; they never acknowledge the browser effect. */
export class NativeMessageSender {
  private waiting = new Map<
    string,
    {
      resolve(): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private ended: Error | null = null;
  private readonly post: (frame: unknown) => void;
  constructor(post: (frame: unknown) => void) {
    this.post = post;
  }

  acceptAcknowledgement(input: unknown): boolean {
    if (
      !input ||
      typeof input !== "object" ||
      (input as { type?: unknown }).type !== "chunk-ack"
    )
      return false;
    const frame = input as { id?: unknown; index?: unknown };
    if (typeof frame.id !== "string" || !Number.isSafeInteger(frame.index))
      throw new BridgeError(
        "INVALID_REQUEST",
        "Invalid native chunk acknowledgement.",
      );
    const key = `${frame.id}:${frame.index}`;
    const pending = this.waiting.get(key);
    if (!pending)
      throw new BridgeError(
        "INVALID_REQUEST",
        "Unexpected native chunk acknowledgement.",
      );
    this.waiting.delete(key);
    clearTimeout(pending.timer);
    pending.resolve();
    return true;
  }

  async send(message: unknown): Promise<void> {
    for (const frame of encodeNativeMessage(message)) {
      if (this.ended) throw this.ended;
      const chunk = frame as { type?: unknown; id?: string; index?: number };
      if (chunk.type !== "chunk") {
        this.post(frame);
        continue;
      }
      await new Promise<void>((resolve, reject) => {
        const key = `${chunk.id}:${chunk.index}`;
        const timer = setTimeout(() => {
          this.waiting.delete(key);
          reject(
            new BridgeError(
              "UNCERTAIN_OUTCOME",
              "Native chunk receipt timed out; no message is replayed.",
            ),
          );
        }, 10000);
        this.waiting.set(key, { resolve, reject, timer });
        try {
          this.post(frame);
        } catch (error) {
          this.waiting.delete(key);
          clearTimeout(timer);
          reject(error);
        }
      });
    }
  }

  close(error: Error): void {
    this.ended = error;
    for (const pending of this.waiting.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.waiting.clear();
  }
}

/** Call only after the assembler has validated and retained the complete chunk. */
export function acknowledgeNativeChunk(
  input: unknown,
  post: (frame: unknown) => void,
): void {
  const frame = input as { type?: unknown; id?: string; index?: number } | null;
  if (frame?.type === "chunk")
    post({ type: "chunk-ack", id: frame.id, index: frame.index });
}
