import pino, { type LogFn, type DestinationStream } from "pino";
import pretty from "pino-pretty";
import { parseBooleanFromText } from "./prompts";

interface LogEntry {
	time?: number;
	[key: string]: unknown;
}

// Custom destination that maintains recent logs in memory
class InMemoryDestination implements DestinationStream {
	private logs: LogEntry[] = [];
	private maxLogs = 1000; // Keep last 1000 logs
	private stream: DestinationStream | null;

	constructor(stream: DestinationStream | null) {
		this.stream = stream;
	}

	write(data: string | LogEntry): void {
		// Parse the log entry if it's a string
		const logEntry: LogEntry =
			typeof data === "string" ? JSON.parse(data) : data;

		// Add timestamp if not present
		if (!logEntry.time) {
			logEntry.time = Date.now();
		}

		// Add to memory buffer
		this.logs.push(logEntry);

		// Maintain buffer size
		if (this.logs.length > this.maxLogs) {
			this.logs.shift();
		}

		// Forward to pretty print stream if available
		if (this.stream) {
			// Ensure we pass a string to the stream
			const stringData = typeof data === "string" ? data : JSON.stringify(data);
			this.stream.write(stringData);
		}
	}

	recentLogs(): LogEntry[] {
		return this.logs;
	}
}

const customLevels: Record<string, number> = {
	fatal: 60,
	error: 50,
	warn: 40,
	info: 30,
	log: 29,
	progress: 28,
	success: 27,
	debug: 20,
	trace: 10,
};

const raw = parseBooleanFromText(process?.env?.LOG_JSON_FORMAT) || false;

const createStream = () => {
	if (raw) {
		return undefined;
	}
	return pretty({
		colorize: true,
		translateTime: "yyyy-mm-dd HH:MM:ss",
		ignore: "pid,hostname",
	});
};

const defaultLevel =
	process?.env?.DEFAULT_LOG_LEVEL || process?.env?.LOG_LEVEL || "info";

const options = {
	level: defaultLevel,
	customLevels,
	hooks: {
		logMethod(
			inputArgs: [string | Record<string, unknown>, ...unknown[]],
			method: LogFn,
		): void {
			const [arg1, ...rest] = inputArgs;

			if (typeof arg1 === "object") {
				const messageParts = rest.map((arg) =>
					typeof arg === "string" ? arg : JSON.stringify(arg),
				);
				const message = messageParts.join(" ");
				method.apply(this, [arg1, message]);
			} else {
				const context = {};
				const messageParts = [arg1, ...rest].map((arg) =>
					typeof arg === "string" ? arg : arg,
				);
				const message = messageParts
					.filter((part) => typeof part === "string")
					.join(" ");
				const jsonParts = messageParts.filter(
					(part) => typeof part === "object",
				);

				Object.assign(context, ...jsonParts);

				method.apply(this, [context, message]);
			}
		},
	},
};

// Create the destination with in-memory logging
const stream = createStream();
const destination = new InMemoryDestination(stream);

// Create logger with custom destination
export const logger = pino(options, destination);

// Expose the destination for accessing recent logs
(logger as unknown)[Symbol.for("pino-destination")] = destination;

// for backward compatibility
export const elizaLogger = logger;

export default logger;
