/** Spec-compliant enough SSE parser for ChatGPT Codex response streams. */
export interface SSEEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";
  let eventName: string | undefined;
  let eventId: string | undefined;
  let retry: number | undefined;
  let dataLines: string[] = [];

  const emit = (): SSEEvent | null => {
    if (dataLines.length === 0 && eventName === undefined && eventId === undefined && retry === undefined) {
      return null;
    }
    const event: SSEEvent = { data: dataLines.join("\n") };
    if (eventName !== undefined) event.event = eventName;
    if (eventId !== undefined) event.id = eventId;
    if (retry !== undefined) event.retry = retry;
    eventName = undefined;
    retry = undefined;
    dataLines = [];
    return event;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const nl = buffer.search(/\r\n|\r|\n/);
        if (nl === -1) break;
        const line = buffer.slice(0, nl);
        const nextChar = buffer[nl] === "\r" && buffer[nl + 1] === "\n" ? 2 : 1;
        buffer = buffer.slice(nl + nextChar);

        if (line === "") {
          const event = emit();
          if (event) yield event;
          continue;
        }
        if (line.startsWith(":")) continue;

        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let valueText = colon === -1 ? "" : line.slice(colon + 1);
        if (valueText.startsWith(" ")) valueText = valueText.slice(1);

        if (field === "event") eventName = valueText;
        else if (field === "data") dataLines.push(valueText);
        else if (field === "id") eventId = valueText;
        else if (field === "retry") {
          const parsed = Number.parseInt(valueText, 10);
          if (Number.isFinite(parsed)) retry = parsed;
        }
      }
    }

    buffer += decoder.decode();
    if (buffer.length > 0) {
      for (const line of buffer.split(/\r\n|\r|\n/)) {
        if (line === "") {
          const event = emit();
          if (event) yield event;
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          let valueText = colon === -1 ? "" : line.slice(colon + 1);
          if (valueText.startsWith(" ")) valueText = valueText.slice(1);
          if (field === "event") eventName = valueText;
          else if (field === "data") dataLines.push(valueText);
          else if (field === "id") eventId = valueText;
        }
      }
    }
    const event = emit();
    if (event) yield event;
  } finally {
    reader.releaseLock();
  }
}
