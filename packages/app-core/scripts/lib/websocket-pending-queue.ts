/** Supports app-core build, packaging, or development orchestration for websocket pending queue ts. */
export type WebSocketSendData =
  | string
  | Buffer
  | ArrayBuffer
  | ArrayBufferView
  | readonly Buffer[];

export type PendingWebSocketMessage<TData extends WebSocketSendData> = {
  data: TData;
  isBinary: boolean;
  byteLength: number;
};

export type PendingWebSocketQueueState<TData extends WebSocketSendData> = {
  messages: Array<PendingWebSocketMessage<TData>>;
  bytes: number;
};

export type PendingWebSocketQueueLimits = {
  maxMessages: number;
  maxMessageBytes: number;
  maxBytes: number;
};

export const DEFAULT_PENDING_WEBSOCKET_QUEUE_LIMITS: PendingWebSocketQueueLimits =
  {
    maxMessages: 128,
    maxMessageBytes: 256 * 1024,
    maxBytes: 1024 * 1024,
  };

export function websocketSendDataByteLength(data: WebSocketSendData): number {
  if (typeof data === "string") {
    return Buffer.byteLength(data);
  }
  if (Buffer.isBuffer(data)) {
    return data.byteLength;
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  if (ArrayBuffer.isView(data)) {
    return data.byteLength;
  }
  return data.reduce((total, chunk) => total + chunk.byteLength, 0);
}

export function createPendingWebSocketQueueState<
  TData extends WebSocketSendData,
>(): PendingWebSocketQueueState<TData> {
  return { messages: [], bytes: 0 };
}

export function clearPendingWebSocketQueue<TData extends WebSocketSendData>(
  state: PendingWebSocketQueueState<TData>,
): void {
  state.messages.length = 0;
  state.bytes = 0;
}

export function drainPendingWebSocketQueue<TData extends WebSocketSendData>(
  state: PendingWebSocketQueueState<TData>,
): Array<PendingWebSocketMessage<TData>> {
  const drained = state.messages.splice(0);
  state.bytes = 0;
  return drained;
}

export function enqueuePendingWebSocketMessage<TData extends WebSocketSendData>(
  state: PendingWebSocketQueueState<TData>,
  message: { data: TData; isBinary: boolean },
  limits: PendingWebSocketQueueLimits = DEFAULT_PENDING_WEBSOCKET_QUEUE_LIMITS,
): boolean {
  const byteLength = websocketSendDataByteLength(message.data);
  if (byteLength > limits.maxMessageBytes || byteLength > limits.maxBytes) {
    return false;
  }

  if (
    state.messages.length >= limits.maxMessages ||
    state.bytes + byteLength > limits.maxBytes
  ) {
    return false;
  }

  state.messages.push({
    ...message,
    byteLength,
  });
  state.bytes += byteLength;
  return true;
}
