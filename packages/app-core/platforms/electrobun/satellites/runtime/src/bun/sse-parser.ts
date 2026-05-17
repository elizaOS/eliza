export type ParsedSSEEvent = {
	event?: string;
	data?: string;
	id?: string;
	retry?: number;
	raw: string;
};

function findEventBreak(buffer: string): { index: number; length: number } | null {
	const lfBreak = buffer.indexOf("\n\n");
	const crlfBreak = buffer.indexOf("\r\n\r\n");
	if (lfBreak === -1 && crlfBreak === -1) return null;
	if (lfBreak === -1) return { index: crlfBreak, length: 4 };
	if (crlfBreak === -1) return { index: lfBreak, length: 2 };
	return lfBreak < crlfBreak
		? { index: lfBreak, length: 2 }
		: { index: crlfBreak, length: 4 };
}

function parseEvent(raw: string): ParsedSSEEvent | null {
	const data: string[] = [];
	let eventName: string | undefined;
	let id: string | undefined;
	let retry: number | undefined;

	for (const line of raw.split(/\r?\n/)) {
		if (line.length === 0 || line.startsWith(":")) continue;
		const colonIndex = line.indexOf(":");
		const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
		const value =
			colonIndex === -1
				? ""
				: line.slice(colonIndex + 1).replace(/^ /, "");
		if (field === "event") {
			eventName = value;
		} else if (field === "data") {
			data.push(value);
		} else if (field === "id") {
			id = value;
		} else if (field === "retry") {
			const parsedRetry = Number.parseInt(value, 10);
			if (Number.isFinite(parsedRetry)) retry = parsedRetry;
		}
	}

	if (
		eventName === undefined &&
		id === undefined &&
		retry === undefined &&
		data.length === 0
	) {
		return null;
	}

	return {
		...(eventName === undefined ? {} : { event: eventName }),
		...(data.length === 0 ? {} : { data: data.join("\n") }),
		...(id === undefined ? {} : { id }),
		...(retry === undefined ? {} : { retry }),
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
