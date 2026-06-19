export type ParsedSSEEvent = {
  event?: string;
  data?: string;
  id?: string;
  retry?: number;
  raw: string;
};

function findEventBreak(
  buffer: string,
): { index: number; length: number } | null {
  const lfBreak = buffer.indexOf("\n\n");
  const crlfBreak = buffer.indexOf("\r\n\r\n");
  if (lfBreak === -1 && crlfBreak === -1) return null;
  if (lfBreak === -1) return { index: crlfBreak, length: 4 };
  if (crlfBreak === -1) return { index: lfBreak, length: 2 };
  return lfBreak < crlfBreak
    ? { index: lfBreak, length: 2 }
    : { index: crlfBreak, length: 4 };
}

type ParsedSSEEventState = {
  data: string[];
  eventName?: string;
  id?: string;
  retry?: number;
};

function parseLine(line: string): { field: string; value: string } | null {
  if (line.length === 0 || line.startsWith(":")) return null;
  const colonIndex = line.indexOf(":");
  return {
    field: colonIndex === -1 ? line : line.slice(0, colonIndex),
    value:
      colonIndex === -1 ? "" : line.slice(colonIndex + 1).replace(/^ /, ""),
  };
}

function applyLine(state: ParsedSSEEventState, line: string): void {
  const parsed = parseLine(line);
  if (parsed === null) return;
  if (parsed.field === "event") state.eventName = parsed.value;
  if (parsed.field === "data") state.data.push(parsed.value);
  if (parsed.field === "id") state.id = parsed.value;
  if (parsed.field === "retry") {
    const parsedRetry = Number.parseInt(parsed.value, 10);
    if (Number.isFinite(parsedRetry)) state.retry = parsedRetry;
  }
}

function stateHasEvent(state: ParsedSSEEventState): boolean {
  return (
    state.eventName !== undefined ||
    state.id !== undefined ||
    state.retry !== undefined ||
    state.data.length > 0
  );
}

function parseEvent(raw: string): ParsedSSEEvent | null {
  const state: ParsedSSEEventState = { data: [] };
  for (const line of raw.split(/\r?\n/)) {
    applyLine(state, line);
  }
  if (!stateHasEvent(state)) return null;
  return {
    ...(state.eventName === undefined ? {} : { event: state.eventName }),
    ...(state.data.length === 0 ? {} : { data: state.data.join("\n") }),
    ...(state.id === undefined ? {} : { id: state.id }),
    ...(state.retry === undefined ? {} : { retry: state.retry }),
    raw,
  };
}

export class SSEParser {
  private buffer = "";

  push(chunk: string): ParsedSSEEvent[] {
    this.buffer += chunk;
    const events: ParsedSSEEvent[] = [];
    let eventBreak = findEventBreak(this.buffer);
    while (eventBreak !== null) {
      const raw = this.buffer.slice(0, eventBreak.index);
      this.buffer = this.buffer.slice(eventBreak.index + eventBreak.length);
      const event = parseEvent(raw);
      if (event !== null) events.push(event);
      eventBreak = findEventBreak(this.buffer);
    }
    return events;
  }

  flush(): ParsedSSEEvent[] {
    const raw = this.buffer;
    this.buffer = "";
    if (raw.trim().length === 0) return [];
    const event = parseEvent(raw);
    return event === null ? [] : [event];
  }
}
