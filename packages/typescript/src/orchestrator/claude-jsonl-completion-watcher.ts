/**
 * Watches the Claude Code session jsonl for each active PTY session and
 * emits a synthetic `task_complete` event when the agent produces an
 * assistant message with `stop_reason === "end_turn"`. This is the
 * ground-truth completion signal from Claude Code's own session record —
 * independent of PTY buffer state, TUI ready events, or the stall
 * classifier's buffer-text heuristics.
 *
 * ## Why this exists
 *
 * The orchestrator's historical completion detection leaned on PTY-side
 * heuristics (buffer silence + ready event + stall-classifier LLM), all of
 * which misfire for long open-ended tasks. Claude Code's own hooks are a
 * more reliable signal and remain the primary path, but hooks can fail
 * silently if the user's hook config is broken or a future Claude Code
 * release changes the contract. The jsonl is a durable, parseable record
 * of every turn written by the CLI itself — using it as an additional
 * ground truth makes completion detection robust across those failure
 * modes.
 *
 * ## Dedup contract with the hook path
 *
 * pty-service.handleHookEvent emits `task_complete` on the authoritative
 * hook signal. This watcher emits a synthetic `task_complete` with an
 * `internal: { source: "jsonl-watcher" }` marker. The orchestrator's
 * downstream consumers (coordinator's handleTurnComplete, the eliza
 * task-progress-streamer) already dedupe `task_complete` per session
 * (`finalSent` in the streamer, `inFlightDecisions` in the coordinator).
 * Whichever signal fires first wins; the second is a no-op.
 *
 * ## Polling vs fs.watch
 *
 * This uses polling (1s interval) rather than `fs.watch` because:
 *   - jsonl files are append-only and small (~KB to MB)
 *   - polling is portable across linux / macOS file systems
 *   - fs.watch on linux has known gotchas with multiple writers and with
 *     files created after the watcher is established
 *   - the jsonl doesn't exist when the session spawns — we need retry
 *     logic anyway, which fs.watch doesn't naturally provide
 *
 * @module orchestrator/claude-jsonl-completion-watcher
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";

const POLL_INTERVAL_MS = 1_000;

interface PTYServiceWithEvents {
	onSessionEvent: (
		cb: (sessionId: string, event: string, data: unknown) => void,
	) => () => void;
	sessionMetadata?: Map<string, Record<string, unknown>>;
	getSession?: (sessionId: string) => { workdir?: string } | undefined;
	handleHookEvent?: (
		sessionId: string,
		event: string,
		data: Record<string, unknown>,
	) => void;
}

const installedRuntimes = new WeakSet<IAgentRuntime>();

/**
 * Install the jsonl completion watcher on a runtime's PTY service.
 * Idempotent — repeat calls on the same runtime are no-ops.
 *
 * The watcher subscribes to `onSessionEvent` to learn when sessions start
 * (first event) and stop (`stopped` event), and runs one poller per live
 * session. Pollers tear themselves down on `stopped` or after firing a
 * completion event.
 */
export function installClaudeJsonlCompletionWatcher(
	runtime: IAgentRuntime,
	ptyService: unknown,
): void {
	if (installedRuntimes.has(runtime)) return;
	const svc = ptyService as PTYServiceWithEvents | undefined;
	if (!svc || typeof svc.onSessionEvent !== "function") return;
	installedRuntimes.add(runtime);

	const pollers = new Map<string, Poller>();
	// Sessions that have already emitted a task_complete (real hook OR
	// our synthetic jsonl emission). Tracked at installer scope so the
	// gate survives across Poller instance teardowns.
	//
	// Without this, every new onSessionEvent for a session that already
	// fired would call startIfMissing() which would create a fresh Poller
	// (no entry in the `pollers` map after a previous stop). The new
	// Poller's own `fired` flag is false, so on its next tick it re-reads
	// the jsonl (still containing the assistant end_turn line) and emits
	// task_complete a second time. We observed this producing 3+ fires
	// per session in testing.
	const firedSessions = new Set<string>();

	const stop = (sessionId: string): void => {
		const poller = pollers.get(sessionId);
		if (!poller) return;
		poller.stop();
		pollers.delete(sessionId);
	};

	const markFiredAndStop = (sessionId: string): void => {
		firedSessions.add(sessionId);
		stop(sessionId);
	};

	const startIfMissing = (sessionId: string): void => {
		if (firedSessions.has(sessionId)) return;
		if (pollers.has(sessionId)) return;
		const workdir = svc.getSession?.(sessionId)?.workdir;
		if (!workdir) return;
		const poller = new Poller(svc, sessionId, workdir, markFiredAndStop);
		pollers.set(sessionId, poller);
		poller.start();
	};

	svc.onSessionEvent((sessionId, event) => {
		// Any first event for a sessionId is our cue to start polling. We
		// deliberately do NOT gate on a particular event type — the jsonl
		// may be written before the first PTY event arrives, and we want
		// the poller alive as early as possible. startIfMissing is itself
		// gated on firedSessions, so late events for already-fired sessions
		// are no-ops rather than spawning zombie pollers.
		startIfMissing(sessionId);

		if (event === "stopped" || event === "error") {
			stop(sessionId);
		}
		if (event === "task_complete") {
			// A real hook-based task_complete arrived — or we emitted our own
			// synthetic one. Either way, mark the session as fired so any
			// subsequent events can't spawn a new poller and re-fire, and
			// shut down any live poller for this session.
			markFiredAndStop(sessionId);
		}
	});
}

/**
 * One poller per session. Owns its own interval and its own cached file
 * size so it only re-reads when the jsonl grows. The per-instance `fired`
 * flag guards against re-entry within a single poller's lifetime; the
 * installer-level `firedSessions` Set (passed in via `onFired`) guards
 * against re-entry across successive poller instances for the same
 * sessionId.
 */
class Poller {
	private timer: ReturnType<typeof setInterval> | null = null;
	private fired = false;
	private lastSize = 0;

	constructor(
		private readonly svc: PTYServiceWithEvents,
		private readonly sessionId: string,
		private readonly workdir: string,
		private readonly onFired: (sessionId: string) => void,
	) {}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.tick();
		}, POLL_INTERVAL_MS);
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	private async tick(): Promise<void> {
		if (this.fired) return;
		const jsonlPath = await findLatestJsonl(this.workdir);
		if (!jsonlPath) return;
		let stat: { size: number };
		try {
			stat = await fs.stat(jsonlPath);
		} catch {
			return;
		}
		if (stat.size === this.lastSize) return;
		this.lastSize = stat.size;

		let content: string;
		try {
			content = await fs.readFile(jsonlPath, "utf-8");
		} catch {
			return;
		}

		const entry = readLatestAssistantEntry(content);
		if (!entry || !entry.isEndTurn) return;

		this.fired = true;
		// onFired adds to firedSessions and stops this poller. Call it
		// BEFORE emitting task_complete so the subsequent onSessionEvent
		// callback (triggered by our own emission) sees firedSessions
		// already populated and doesn't start a new poller.
		this.onFired(this.sessionId);
		logger.info(
			`[claude-jsonl-watcher] detected end_turn for ${this.sessionId} — emitting synthetic task_complete (${entry.text.length} chars)`,
		);
		// Route through the same handleHookEvent pathway the real hook uses,
		// so downstream consumers receive an identical event shape and the
		// existing dedup guards apply transparently.
		this.svc.handleHookEvent?.(this.sessionId, "task_complete", {
			response: entry.text,
			source: "jsonl-watcher",
		});
	}
}

/**
 * Locate the newest `.jsonl` file under Claude Code's project directory
 * for a given workdir. Returns null if the directory or any matching
 * file does not yet exist (e.g., the session has not produced output).
 *
 * "Newest" means most recently modified. Claude Code names session files
 * with UUIDs, which do NOT sort chronologically — a workspace that has
 * had multiple sessions will have multiple jsonl files, and picking the
 * lexicographically last name returns a stale file from an older session
 * roughly at random. We stat each file and pick the one with the greatest
 * mtime instead. Files that fail to stat (e.g., deleted between readdir
 * and stat) are skipped.
 *
 * Exported for tests.
 */
export async function findLatestJsonl(workdir: string): Promise<string | null> {
	const home = process.env.HOME ?? os.homedir();
	// Claude Code encodes project paths by replacing both `/` and `.` with
	// `-`. For example:
	//   /home/eliza/.eliza/workspaces/abc → -home-eliza--eliza-workspaces-abc
	// (the `/.` in `/.eliza` maps to `--`).
	const projectKey = workdir.replace(/[/.]/g, "-");
	const projectDir = path.join(home, ".claude", "projects", projectKey);
	let entries: string[];
	try {
		entries = await fs.readdir(projectDir);
	} catch {
		return null;
	}
	const jsonls = entries.filter((f) => f.endsWith(".jsonl"));
	if (jsonls.length === 0) return null;
	const stats = await Promise.all(
		jsonls.map(async (name) => {
			const full = path.join(projectDir, name);
			try {
				const st = await fs.stat(full);
				return { full, mtimeMs: st.mtimeMs };
			} catch {
				return null;
			}
		}),
	);
	let newest: { full: string; mtimeMs: number } | null = null;
	for (const entry of stats) {
		if (!entry) continue;
		if (!newest || entry.mtimeMs > newest.mtimeMs) newest = entry;
	}
	return newest?.full ?? null;
}

/**
 * Scan a claude code session jsonl string tail-first for the latest
 * assistant message, returning its extracted text plus whether the turn
 * has finished (`stop_reason === "end_turn"`).
 *
 * - Returns `null` if no assistant message exists at all.
 * - Returns `{ text, isEndTurn: false }` when the latest assistant turn is
 *   still in progress (`tool_use`, `max_tokens` mid-batch, etc.) — the
 *   streamer uses this shape to post intermediate text without waiting.
 * - Returns `{ text, isEndTurn: true }` when the latest assistant turn is
 *   finished — the watcher uses this to fire a synthetic `task_complete`.
 *
 * Exported so both the completion watcher and task-progress-streamer can
 * share one jsonl parser.
 */
export function readLatestAssistantEntry(
	content: string,
): { text: string; isEndTurn: boolean } | null {
	const lines = content.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line) continue;
		let msg:
			| {
					role?: string;
					stop_reason?: string;
					content?: Array<{ type?: string; text?: string }>;
			  }
			| undefined;
		try {
			msg = (JSON.parse(line) as { message?: typeof msg }).message;
		} catch {
			continue;
		}
		if (!msg || msg.role !== "assistant") continue;
		let text = "";
		for (const c of msg.content ?? []) {
			if (c.type === "text" && typeof c.text === "string" && c.text.trim()) {
				text += (text ? "\n" : "") + c.text.trim();
			}
		}
		return { text, isEndTurn: msg.stop_reason === "end_turn" };
	}
	return null;
}

/**
 * Convenience wrapper: locate the latest session jsonl for `workdir` and
 * return the extracted assistant entry, or `null` if no file or no
 * assistant message exists yet.
 *
 * Used by the task-progress-streamer and the completion watcher so they
 * share one implementation of "read the latest claude assistant turn".
 */
export async function readLatestAssistantFromWorkdir(
	workdir: string,
): Promise<{ text: string; isEndTurn: boolean } | null> {
	const jsonlPath = await findLatestJsonl(workdir);
	if (!jsonlPath) return null;
	let content: string;
	try {
		content = await fs.readFile(jsonlPath, "utf-8");
	} catch {
		return null;
	}
	return readLatestAssistantEntry(content);
}
