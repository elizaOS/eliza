export const MAX_NATIVE_BYTES: number;

export class BridgeError extends Error {
  readonly kind: string;
  readonly reason: string | undefined;
  constructor(kind: string, message: string, reason?: string);
}

export function serializeCompleteMessage(value: unknown): unknown;

export function parseCommand(input: unknown): {
  id: string;
  command: Record<string, unknown>;
};

export function encodeNativeMessage(message: unknown): unknown[];

export class NativeMessageAssembler {
  accept(input: unknown): unknown;
}

export class NativeMessageSender {
  constructor(post: (frame: unknown) => void);
  acceptAcknowledgement(input: unknown): boolean;
  send(message: unknown): Promise<void>;
  close(error: Error): void;
}

export function acknowledgeNativeChunk(
  input: unknown,
  post: (frame: unknown) => void,
): void;
