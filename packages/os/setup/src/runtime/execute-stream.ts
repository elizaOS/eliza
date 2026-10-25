export class ExecutionStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionStreamError";
  }
}

/** A successful HTTP response is not proof that the requested operation finished. */
export async function readExecutionStream(
  response: Response,
  onProgress: (frame: Record<string, unknown>) => void,
): Promise<void> {
  if (!response.ok || !response.body)
    throw new ExecutionStreamError(
      `Execution request failed: HTTP ${response.status}`,
    );
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let completed = false;
  let failure: string | undefined;
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 50 * 1024 * 1024)
        throw new ExecutionStreamError(
          "Execution progress exceeded the 50 MiB limit.",
        );
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const lines = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"));
        if (!lines.length) continue;
        if (completed)
          throw new ExecutionStreamError("Received an event after completion.");
        const parsed: unknown = JSON.parse(
          lines.map((line) => line.slice(5).trimStart()).join("\n"),
        );
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new ExecutionStreamError("Malformed progress event.");
        const event = parsed as Record<string, unknown>;
        if (Object.hasOwn(event, "done") || Object.hasOwn(event, "error")) {
          if (Object.keys(event).length !== 1)
            throw new ExecutionStreamError("Contradictory terminal event.");
          if (event.done === true) completed = true;
          else if (typeof event.error === "string")
            throw new ExecutionStreamError(event.error);
          else throw new ExecutionStreamError("Malformed terminal event.");
        } else {
          onProgress(event);
          if (event.status === "failed")
            failure ??=
              typeof event.detail === "string"
                ? event.detail
                : "Execution failed.";
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim())
      throw new ExecutionStreamError("Truncated execution progress event.");
    if (failure !== undefined) throw new ExecutionStreamError(failure);
    if (!completed)
      throw new ExecutionStreamError(
        "Execution ended without a completion event.",
      );
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
