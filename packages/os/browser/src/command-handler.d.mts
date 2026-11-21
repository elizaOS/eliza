export function createCommandHandler(
  api: unknown,
  options?: { effects?: unknown },
): (
  message: unknown,
  sender: { send(value: unknown): unknown },
  connectionCurrent: () => boolean,
) => Promise<void>;
