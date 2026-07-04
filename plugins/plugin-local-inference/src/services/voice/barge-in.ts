/**
 * Barge-in controller — distinguishes a blip from real speech while the
 * agent is talking, and turns that into TTS pause/resume/hard-stop plus an
 * LLM-generation abort.
 *
 * Inputs:
 *   - the `VadEvent` stream from `VadDetector` (subscribe via `bindVad()`),
 *   - W2's ASR word-confirm callback (`onWordsDetected()` — the
 *     `WordsDetectedSink` contract).
 *
 * Behaviour while the agent is speaking (`agentSpeaking === true`):
 *   - `speech-active`  → emit `pause-tts`. (Provisional — could still be a
 *                        blip; the energy-duration heuristic guesses, ASR
 *                        confirms.)
 *   - `blip` (or a short `speech-end` before any words)
 *                      → emit `resume-tts`. The agent keeps talking.
 *   - `onWordsDetected({wordCount ≥ 1})` → emit `hard-stop` with a fresh
 *                        `BargeInCancelToken`. Hard-stop means: cancel TTS
 *                        *and* abort the in-flight LLM / MTP drafter
 *                        generation. The engine layer (W9) threads
 *                        `token.signal` into `dispatcher.generate` and polls
 *                        `token.cancelled` at kernel boundaries.
 *   - `speech-end` with a long-enough segment but no ASR words yet →
 *                        treated as words-pending: emit `hard-stop` only
 *                        once ASR confirms; if ASR never confirms within
 *                        `wordsGraceMs`, resume TTS (it was non-speech the
 *                        Silero VAD let through).
 *
 * Legacy API (still used by `VoiceScheduler` and `EngineVoiceBridge`):
 *   `attach({onCancel})`, `onMicActive()`, `cancelSignal()`, `reset()` — a
 *   thin "everything cancelled" path. `onMicActive()` is now equivalent to
 *   `hardStop("manual")`.
 *
 * No fallback sludge: a `hard-stop` always carries a real `AbortSignal`; the
 * controller never swallows a VAD event.
 */

import type {
	BargeInCancelToken,
	BargeInSignal,
	BargeInSignalListener,
	VadEvent,
	VadEventListener,
	WordsDetectedSink,
} from "./types";

/** Minimal structural view of `VadDetector` — avoids a module dependency on
 *  `vad.ts` (which pulls in the fused `libelizainference` VAD FFI surface). */
interface VadEventSource {
	onVadEvent(listener: VadEventListener): () => void;
}

// --- Legacy interfaces (kept; `VoiceScheduler` depends on them) ------------

export interface BargeInListener {
	onCancel(): void;
}

export interface CancelSignal {
	cancelled: boolean;
}

export type BargeInSpeakerProfileMatch = "owner" | "enrolled" | "unknown";

export interface BargeInInterruptEvidence {
	selfVoiceSimilarity?: number;
	speakerProfileMatch?: BargeInSpeakerProfileMatch;
	wakeWordDetected?: boolean;
}

export type BargeInInterruptGate = (
	evidence: BargeInInterruptEvidence,
) => "allow" | "deny";

// --- New: cancel token --------------------------------------------------------

function makeCancelToken(
	reason: BargeInCancelToken["reason"],
): BargeInCancelToken {
	const controller = new AbortController();
	const token: BargeInCancelToken = {
		cancelled: false,
		reason: null,
		signal: controller.signal,
	};
	const trip = (r: BargeInCancelToken["reason"]) => {
		if (token.cancelled) return;
		token.cancelled = true;
		token.reason = r;
		controller.abort();
	};
	if (reason) trip(reason);
	// Expose the tripper on a non-enumerable slot for the controller to use.
	Object.defineProperty(token, "__trip", { value: trip, enumerable: false });
	return token;
}

function tripToken(
	token: BargeInCancelToken,
	reason: BargeInCancelToken["reason"],
): void {
	const trip = (token as { __trip?: (r: BargeInCancelToken["reason"]) => void })
		.__trip;
	if (trip) trip(reason);
}

export interface BargeInControllerConfig {
	/**
	 * After a `speech-active` (TTS paused) with no ASR word confirmation,
	 * resume TTS if ASR has not reported ≥1 word within this window. Default
	 * 600 ms. Long enough for a streaming ASR partial; short enough that a
	 * cough doesn't keep the agent muted.
	 */
	wordsGraceMs?: number;
	/**
	 * Gate only the destructive hard-stop decision. TTS still pauses on any
	 * speech while the agent is talking; the gate decides whether confirmed ASR
	 * words are allowed to abort TTS and generation.
	 */
	interruptGate?: BargeInInterruptGate;
	/** Agent-voice centroid threshold; distinct from the human profile bar. */
	agentSelfVoiceThreshold?: number;
	/** Whether unenrolled speakers may interrupt. Defaults to true. */
	allowUnknownBystanders?: boolean;
}

const DEFAULT_WORDS_GRACE_MS = 600;
const DEFAULT_AGENT_SELF_VOICE_THRESHOLD = 0.28;

function readWordsGraceMs(): number {
	const raw = process.env.ELIZA_VOICE_BARGE_IN_GRACE_MS?.trim();
	if (!raw) return DEFAULT_WORDS_GRACE_MS;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0
		? parsed
		: DEFAULT_WORDS_GRACE_MS;
}

function readAllowUnknownBystanders(): boolean {
	const raw = process.env.ELIZA_VOICE_BARGE_IN_BYSTANDERS?.trim().toLowerCase();
	if (!raw) return true;
	return !["0", "false", "deny", "block", "off"].includes(raw);
}

export function createDefaultBargeInInterruptGate(
	options: {
		agentSelfVoiceThreshold?: number;
		allowUnknownBystanders?: boolean;
	} = {},
): BargeInInterruptGate {
	const agentSelfVoiceThreshold =
		options.agentSelfVoiceThreshold ?? DEFAULT_AGENT_SELF_VOICE_THRESHOLD;
	const allowUnknownBystanders =
		options.allowUnknownBystanders ?? readAllowUnknownBystanders();
	return (evidence) => {
		if (evidence.wakeWordDetected) return "allow";
		if (
			typeof evidence.selfVoiceSimilarity === "number" &&
			evidence.selfVoiceSimilarity >= agentSelfVoiceThreshold
		) {
			return "deny";
		}
		if (evidence.speakerProfileMatch === "unknown" && !allowUnknownBystanders) {
			return "deny";
		}
		return "allow";
	};
}

export class BargeInController implements WordsDetectedSink {
	private readonly listeners = new Set<BargeInListener>();
	private readonly signalListeners = new Set<BargeInSignalListener>();
	private readonly wordsGraceMs: number;
	private readonly interruptGate: BargeInInterruptGate;

	/** Legacy single-shot cancel flag, reset by `reset()`. */
	private signal: CancelSignal = { cancelled: false };

	/** True while the agent's TTS is playing. The turn controller / scheduler
	 *  flips this via `setAgentSpeaking()`. Barge-in logic only acts while
	 *  this is true. */
	private agentSpeaking = false;
	/** True while we have emitted `pause-tts` and are waiting on the
	 *  blip-vs-words decision. */
	private awaitingWordConfirm = false;
	private wordConfirmDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
	private wordConfirmExpiresAtMs: number | null = null;
	private lastEventTimestampMs = 0;
	private vadUnsub: (() => void) | null = null;

	constructor(config: BargeInControllerConfig = {}) {
		this.wordsGraceMs = config.wordsGraceMs ?? readWordsGraceMs();
		this.interruptGate =
			config.interruptGate ??
			createDefaultBargeInInterruptGate({
				...(config.agentSelfVoiceThreshold !== undefined
					? { agentSelfVoiceThreshold: config.agentSelfVoiceThreshold }
					: {}),
				...(config.allowUnknownBystanders !== undefined
					? { allowUnknownBystanders: config.allowUnknownBystanders }
					: {}),
			});
	}

	// --- New subscription API ---------------------------------------------------

	/** Subscribe to `pause-tts` / `resume-tts` / `hard-stop`. */
	onSignal(listener: BargeInSignalListener): () => void {
		this.signalListeners.add(listener);
		return () => this.signalListeners.delete(listener);
	}

	/** Wire this controller to a `VadDetector`. Returns an unsubscribe fn. */
	bindVad(detector: VadEventSource): () => void {
		this.unbindVad();
		this.vadUnsub = detector.onVadEvent((e: VadEvent) => this.onVadEvent(e));
		return () => this.unbindVad();
	}

	unbindVad(): void {
		if (this.vadUnsub) {
			this.vadUnsub();
			this.vadUnsub = null;
		}
	}

	/** The turn controller flips this when TTS starts/stops playing. */
	setAgentSpeaking(speaking: boolean): void {
		if (this.agentSpeaking === speaking) return;
		this.agentSpeaking = speaking;
		if (!speaking) {
			// Agent stopped talking on its own — drop any pending word-confirm.
			this.clearWordConfirm();
			this.awaitingWordConfirm = false;
		}
	}

	get isAgentSpeaking(): boolean {
		return this.agentSpeaking;
	}

	// --- VAD event handling -----------------------------------------------------

	private onVadEvent(event: VadEvent): void {
		this.lastEventTimestampMs = event.timestampMs;
		if (!this.agentSpeaking) return;
		switch (event.type) {
			case "speech-start":
			case "speech-active": {
				if (!this.awaitingWordConfirm) {
					this.awaitingWordConfirm = true;
					this.emitSignal({
						type: "pause-tts",
						timestampMs: event.timestampMs,
					});
					this.armWordConfirmDeadline(event.timestampMs);
				}
				break;
			}
			case "blip": {
				// Definitely not speech — resume immediately.
				if (this.awaitingWordConfirm) {
					this.awaitingWordConfirm = false;
					// Stop the pending auto-resume timer, but keep the ASR grace
					// window alive. A VAD blip decision can arrive before the ASR
					// partial for the same audio; if words land inside the original
					// window, they are authoritative and should still hard-stop.
					this.clearWordConfirm({ keepWindow: true });
					this.emitSignal({
						type: "resume-tts",
						timestampMs: event.timestampMs,
					});
				}
				break;
			}
			case "speech-pause":
				// Still ambiguous; keep TTS paused, wait on ASR / the deadline.
				break;
			case "speech-end": {
				// The Silero VAD considers this a finished segment. If ASR hasn't
				// confirmed words by now, the grace deadline will resume TTS; if it
				// has, `onWordsDetected` already hard-stopped. Nothing extra here.
				break;
			}
		}
	}

	// --- ASR word-confirm sink (WordsDetectedSink) ------------------------------

	onWordsDetected(args: {
		wordCount: number;
		partialText: string;
		timestampMs: number;
		evidence?: BargeInInterruptEvidence;
	}): void {
		if (args.wordCount < 1) return;
		const withinConfirmWindow =
			this.wordConfirmExpiresAtMs != null &&
			args.timestampMs <= this.wordConfirmExpiresAtMs;
		if (
			!this.agentSpeaking ||
			(!this.awaitingWordConfirm && !withinConfirmWindow)
		) {
			return;
		}
		if (this.interruptGate(args.evidence ?? {}) === "deny") {
			this.awaitingWordConfirm = false;
			this.clearWordConfirm();
			this.emitSignal({
				type: "resume-tts",
				timestampMs: args.timestampMs,
			});
			return;
		}
		// Authoritative: real user speech. Hard-stop.
		this.hardStop("barge-in-words", args.timestampMs);
	}

	// --- Hard stop --------------------------------------------------------------

	/**
	 * Cancel TTS + abort the in-flight LLM / drafter generation. Returns the
	 * `BargeInCancelToken` whose `signal` the engine layer aborts on. Idempotent
	 * within a single barge-in episode — calling it again returns the same
	 * token until `reset()`.
	 */
	hardStop(
		reason: NonNullable<BargeInCancelToken["reason"]> = "manual",
		timestampMs: number = this.lastEventTimestampMs || Date.now(),
	): BargeInCancelToken {
		this.clearWordConfirm();
		this.awaitingWordConfirm = false;
		if (!this.activeToken) {
			this.activeToken = makeCancelToken(null);
		}
		tripToken(this.activeToken, reason);
		// Legacy cancel flag + listeners.
		this.signal.cancelled = true;
		for (const l of this.listeners) l.onCancel();
		this.emitSignal({
			type: "hard-stop",
			timestampMs,
			token: this.activeToken,
		});
		return this.activeToken;
	}

	private activeToken: BargeInCancelToken | null = null;

	/** The cancel token for the current barge-in episode (null until a
	 *  `hard-stop`). The engine threads `.signal` into generation. */
	currentCancelToken(): BargeInCancelToken | null {
		return this.activeToken;
	}

	// --- Legacy API (VoiceScheduler / EngineVoiceBridge) ------------------------

	/** @deprecated Use `currentCancelToken()`; kept for `VoiceScheduler`. */
	cancelSignal(): CancelSignal {
		return this.signal;
	}

	attach(listener: BargeInListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** @deprecated Equivalent to `hardStop("manual")`; kept for the bridge. */
	onMicActive(): void {
		this.hardStop("manual");
	}

	reset(): void {
		this.clearWordConfirm();
		this.awaitingWordConfirm = false;
		this.activeToken = null;
		this.signal = { cancelled: false };
	}

	// --- internals --------------------------------------------------------------

	private emitSignal(signal: BargeInSignal): void {
		for (const l of this.signalListeners) l(signal);
	}

	private armWordConfirmDeadline(timestampMs: number): void {
		this.clearWordConfirm();
		this.wordConfirmExpiresAtMs = timestampMs + this.wordsGraceMs;
		this.wordConfirmDeadlineTimer = setTimeout(() => {
			this.wordConfirmDeadlineTimer = null;
			if (this.awaitingWordConfirm && this.agentSpeaking) {
				// ASR never confirmed a word — the Silero VAD let through
				// non-speech. Resume TTS.
				this.awaitingWordConfirm = false;
				this.emitSignal({
					type: "resume-tts",
					timestampMs: timestampMs + this.wordsGraceMs,
				});
			}
			this.wordConfirmExpiresAtMs = null;
		}, this.wordsGraceMs);
		// Don't keep the event loop alive on this timer.
		if (
			this.wordConfirmDeadlineTimer &&
			typeof (this.wordConfirmDeadlineTimer as { unref?: () => void }).unref ===
				"function"
		) {
			(this.wordConfirmDeadlineTimer as { unref: () => void }).unref();
		}
	}

	private clearWordConfirm(options: { keepWindow?: boolean } = {}): void {
		if (this.wordConfirmDeadlineTimer) {
			clearTimeout(this.wordConfirmDeadlineTimer);
			this.wordConfirmDeadlineTimer = null;
		}
		if (!options.keepWindow) {
			this.wordConfirmExpiresAtMs = null;
		}
	}
}
