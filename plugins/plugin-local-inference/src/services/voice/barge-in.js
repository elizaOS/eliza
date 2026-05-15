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
 *                        *and* abort the in-flight LLM / DFlash drafter
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
// --- New: cancel token --------------------------------------------------------
function makeCancelToken(reason) {
	const controller = new AbortController();
	const token = {
		cancelled: false,
		reason: null,
		signal: controller.signal,
	};
	const trip = (r) => {
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
function tripToken(token, reason) {
	const trip = token.__trip;
	if (trip) trip(reason);
}
export class BargeInController {
	listeners = new Set();
	signalListeners = new Set();
	wordsGraceMs;
	/** Legacy single-shot cancel flag, reset by `reset()`. */
	signal = { cancelled: false };
	/** True while the agent's TTS is playing. The turn controller / scheduler
	 *  flips this via `setAgentSpeaking()`. Barge-in logic only acts while
	 *  this is true. */
	agentSpeaking = false;
	/** True while we have emitted `pause-tts` and are waiting on the
	 *  blip-vs-words decision. */
	awaitingWordConfirm = false;
	wordConfirmDeadlineTimer = null;
	wordConfirmExpiresAtMs = null;
	lastEventTimestampMs = 0;
	vadUnsub = null;
	constructor(config = {}) {
		this.wordsGraceMs = config.wordsGraceMs ?? 600;
	}
	// --- New subscription API ---------------------------------------------------
	/** Subscribe to `pause-tts` / `resume-tts` / `hard-stop`. */
	onSignal(listener) {
		this.signalListeners.add(listener);
		return () => this.signalListeners.delete(listener);
	}
	/** Wire this controller to a `VadDetector`. Returns an unsubscribe fn. */
	bindVad(detector) {
		this.unbindVad();
		this.vadUnsub = detector.onVadEvent((e) => this.onVadEvent(e));
		return () => this.unbindVad();
	}
	unbindVad() {
		if (this.vadUnsub) {
			this.vadUnsub();
			this.vadUnsub = null;
		}
	}
	/** The turn controller flips this when TTS starts/stops playing. */
	setAgentSpeaking(speaking) {
		if (this.agentSpeaking === speaking) return;
		this.agentSpeaking = speaking;
		if (!speaking) {
			// Agent stopped talking on its own — drop any pending word-confirm.
			this.clearWordConfirm();
			this.awaitingWordConfirm = false;
		}
	}
	get isAgentSpeaking() {
		return this.agentSpeaking;
	}
	// --- VAD event handling -----------------------------------------------------
	onVadEvent(event) {
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
	onWordsDetected(args) {
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
		reason = "manual",
		timestampMs = this.lastEventTimestampMs || Date.now(),
	) {
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
	activeToken = null;
	/** The cancel token for the current barge-in episode (null until a
	 *  `hard-stop`). The engine threads `.signal` into generation. */
	currentCancelToken() {
		return this.activeToken;
	}
	// --- Legacy API (VoiceScheduler / EngineVoiceBridge) ------------------------
	/** @deprecated Use `currentCancelToken()`; kept for `VoiceScheduler`. */
	cancelSignal() {
		return this.signal;
	}
	attach(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	/** @deprecated Equivalent to `hardStop("manual")`; kept for the bridge. */
	onMicActive() {
		this.hardStop("manual");
	}
	reset() {
		this.clearWordConfirm();
		this.awaitingWordConfirm = false;
		this.activeToken = null;
		this.signal = { cancelled: false };
	}
	// --- internals --------------------------------------------------------------
	emitSignal(signal) {
		for (const l of this.signalListeners) l(signal);
	}
	armWordConfirmDeadline(timestampMs) {
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
			typeof this.wordConfirmDeadlineTimer.unref === "function"
		) {
			this.wordConfirmDeadlineTimer.unref();
		}
	}
	clearWordConfirm(options = {}) {
		if (this.wordConfirmDeadlineTimer) {
			clearTimeout(this.wordConfirmDeadlineTimer);
			this.wordConfirmDeadlineTimer = null;
		}
		if (!options.keepWindow) {
			this.wordConfirmExpiresAtMs = null;
		}
	}
}
//# sourceMappingURL=barge-in.js.map
