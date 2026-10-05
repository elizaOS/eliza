import type { JsonValue } from "@elizaos/core";
import { createUnknownDatabaseSnapshot } from "../database";
import type {
	LaunchEvent,
	LaunchEventsTailResult,
	LaunchPhase,
	LaunchSnapshot,
} from "./types";

const DEFAULT_MAX_EVENTS = 500;

function emptySnapshot(now: () => Date): LaunchSnapshot {
	return {
		phase: "static-shell",
		agent: {
			state: "not_started",
			port: null,
			apiBase: null,
			startedAt: null,
			error: null,
		},
		boot: {
			runtimePhase: null,
			pluginsLoaded: null,
			pluginsFailed: null,
			database: null,
		},
		database: createUnknownDatabaseSnapshot(now().toISOString()),
		auth: {
			checked: false,
			required: null,
		},
		firstRun: {
			checked: false,
			complete: null,
			requiredGate: null,
		},
		localModel: {
			backgroundDownloadQueued: false,
			blocking: false,
		},
		diagnostics: {
			logPath: "",
			statusPath: "",
		},
		recovery: {
			canRetry: false,
			canOpenLogs: false,
			canCreateBugReport: false,
		},
		updatedAt: now().toISOString(),
	};
}

export class LaunchStore {
	private snapshot: LaunchSnapshot;
	private readonly events: LaunchEvent[] = [];
	private sequence = 0;
	private readonly maxEvents: number;
	private readonly now: () => Date;

	constructor(options?: {
		initialSnapshot?: LaunchSnapshot;
		maxEvents?: number;
		now?: () => Date;
	}) {
		this.now = options?.now ?? (() => new Date());
		this.maxEvents = options?.maxEvents ?? DEFAULT_MAX_EVENTS;
		this.snapshot = options?.initialSnapshot ?? emptySnapshot(this.now);
	}

	getSnapshot(): LaunchSnapshot {
		return structuredClone(this.snapshot);
	}

	update(
		snapshot: LaunchSnapshot,
		event?: { name: string; payload?: JsonValue },
	): LaunchSnapshot {
		const previousPhase = this.snapshot.phase;
		this.snapshot = structuredClone(snapshot);
		if (event) {
			this.recordEvent(event.name, snapshot.phase, event.payload);
		} else if (previousPhase !== snapshot.phase) {
			this.recordEvent("launch.phase.changed", snapshot.phase, {
				previousPhase,
				phase: snapshot.phase,
			});
		}
		return this.getSnapshot();
	}

	recordEvent(
		name: string,
		phase: LaunchPhase = this.snapshot.phase,
		payload?: JsonValue,
	): LaunchEvent {
		this.sequence += 1;
		const event: LaunchEvent = {
			sequence: this.sequence,
			phase,
			name,
			timestamp: this.now().toISOString(),
		};
		if (payload !== undefined) event.payload = structuredClone(payload);
		this.events.push(event);
		if (this.events.length > this.maxEvents) {
			this.events.splice(0, this.events.length - this.maxEvents);
		}
		return structuredClone(event);
	}

	/**
	 * Without a cursor, returns the most recent `limit` events (diagnostics
	 * snapshot). With `afterSequence`, returns the oldest `limit` events after
	 * that cursor in sequence order, and `nextSequence` is the sequence of the
	 * last returned event so a poller resumes exactly where the page ended.
	 */
	tailEvents(afterSequence?: number, limit = 100): LaunchEventsTailResult {
		const cappedLimit = Math.max(1, Math.min(limit, this.maxEvents));
		const events =
			afterSequence === undefined
				? this.events.slice(-cappedLimit)
				: this.events
						.filter((event) => event.sequence > afterSequence)
						.slice(0, cappedLimit);
		return {
			events: structuredClone(events),
			nextSequence: events.at(-1)?.sequence ?? this.sequence,
		};
	}

	reset(snapshot?: LaunchSnapshot): void {
		this.snapshot = snapshot ?? emptySnapshot(this.now);
		this.events.length = 0;
		this.sequence = 0;
	}
}
