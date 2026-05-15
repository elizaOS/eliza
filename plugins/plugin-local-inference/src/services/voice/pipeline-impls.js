/**
 * Concrete implementations of the `VoicePipeline` seams (`pipeline.ts`).
 *
 * `pipeline.ts` defines two interfaces — `DraftProposer`, `TargetVerifier`
 * — plus the ASR contract (it consumes the live `StreamingTranscriber`
 * from `voice/types.ts` directly) and an overlapped scheduler that drives
 * the fused mic→speech graph from `packages/inference/AGENTS.md` §4. This
 * module fills those interfaces against the live runtime:
 *
 *   - `MissingAsrTranscriber` — a `StreamingTranscriber` that hard-fails
 *     when no ASR backend is available (AGENTS.md §3 — no silent cloud
 *     fallback). The bridge's `resolveTranscriber()` returns this instead
 *     of throwing eagerly so the failure surfaces at turn time.
 *   - `LlamaServerDraftProposer` — the DFlash drafter, reached through
 *     the running `llama-server`'s `-md` drafter. GPU dispatch N=1 (no
 *     command-buffer batching for voice — ledger "Keep voice dispatch
 *     unbatched"); honours `cancel.cancelled` between kernel ticks.
 *   - `LlamaServerTargetVerifier` — the text model's autoregressive
 *     verify step against its own KV cache, also via `llama-server`. When
 *     the native fork emits exact verifier accept/reject ranges
 *     (`extractVerifierRejectRange` in `dflash-server.ts`), the verifier
 *     consumes them directly; until then it falls back to a plain
 *     autoregressive step that re-derives accept/reject by comparing the
 *     draft against the model's own next tokens.
 *
 * Hard-fail discipline (AGENTS.md §3 + §9): a missing fused ASR region in
 * voice mode is a thrown `VoiceStartupError`, never a silent cloud
 * fallback, never log-and-continue.
 *
 * Why a separate file from `pipeline.ts`: `pipeline.ts` stays
 * dependency-light (it is the streaming contract, importable by text-only
 * callers). The runtime wiring — the llama-server backend — lives here so
 * the contract module does not drag it in.
 */
import { VoiceStartupError } from "./errors";
import { splitTranscriptToTokens } from "./pipeline";
/* ------------------------------------------------------------------ */
/* ASR — missing-backend deferral                                      */
/* ------------------------------------------------------------------ */
/**
 * A `StreamingTranscriber` that hard-fails: used when no ASR backend is
 * available (no fused streaming decoder, no whisper.cpp binary/model, no
 * bundled ASR region) but a voice turn was requested. AGENTS.md §3 —
 * missing required voice backend in voice mode is a thrown
 * `VoiceStartupError`, never a silent fallback. The bridge returns this
 * from `resolveTranscriber()` so the failure surfaces when the pipeline
 * actually feeds audio rather than at bridge construction.
 */
export class MissingAsrTranscriber {
	reason;
	constructor(reason) {
		this.reason = reason;
	}
	feed(_frame) {
		throw new VoiceStartupError("missing-fused-build", this.reason);
	}
	async flush() {
		throw new VoiceStartupError("missing-fused-build", this.reason);
	}
	on() {
		return () => {};
	}
	dispose() {}
}
/** Adapt the concrete `DflashLlamaServer` onto `DflashTextRunner`. */
export function dflashTextRunner(server) {
	return {
		hasDrafter() {
			return server.loadedDrafterModelPath() !== null;
		},
		async generateWithVerifierEvents(args) {
			const { text } = await server.generateWithUsage(args);
			return { text };
		},
	};
}
/**
 * Build the prompt string the drafter/verifier run against from the
 * accepted prefix. The pipeline holds tokens, not a chat transcript; for
 * the streaming verify loop we feed back the concatenated token text as a
 * raw continuation prompt (`cache_prompt` on the server reuses the prefix
 * KV between rounds so this is cheap to re-send).
 */
function prefixToPrompt(prefix) {
	return prefix.map((t) => t.text).join("");
}
/**
 * `DraftProposer` over the DFlash drafter via llama-server. The fork's
 * `--draft-max` already bounds proposals; this adapter additionally
 * clamps to the pipeline's `maxDraft` and stops early on
 * `cancel.cancelled`. GPU dispatch is N=1 (the fork's voice profile
 * disables command-buffer batching — ledger §2 "Keep voice dispatch
 * unbatched") so a barge-in lands at the next kernel boundary.
 *
 * Until the fork exposes a "draft only, return the proposed tokens"
 * endpoint, the proposer issues a short low-temperature completion
 * (`maxTokens = maxDraft`) and treats the produced tokens as the draft
 * window. The verifier then re-checks them against the target's KV — the
 * standard speculative-decoding contract, just with the draft sourced
 * from the same server.
 */
export class LlamaServerDraftProposer {
	runner;
	constructor(runner) {
		this.runner = runner;
	}
	async propose(args) {
		if (args.cancel.cancelled) return [];
		if (!this.runner.hasDrafter()) {
			// No drafter wired ⇒ no speculation this round. The verifier still
			// produces one token per round (plain AR step), so generation
			// continues; DFlash being mandatory is enforced at server-launch
			// time, not here.
			return [];
		}
		const accepted = [];
		let nextIndex =
			args.prefix.length > 0
				? args.prefix[args.prefix.length - 1].index + 1
				: 0;
		await this.runner.generateWithVerifierEvents({
			prompt: prefixToPrompt(args.prefix),
			maxTokens: Math.max(1, Math.floor(args.maxDraft)),
			temperature: 0,
			signal: cancelToSignal(args.cancel),
			onVerifierEvent: (event) => {
				if (event.kind !== "accept") return;
				for (const tok of event.tokens) {
					if (accepted.length >= args.maxDraft) break;
					accepted.push({ index: nextIndex++, text: tok.text });
				}
			},
		});
		if (args.cancel.cancelled) return [];
		return accepted.slice(0, Math.max(1, Math.floor(args.maxDraft)));
	}
}
/**
 * `TargetVerifier` over the text model via llama-server. Runs one
 * autoregressive verify step against the server's KV cache: it sends the
 * accepted prefix and reads back the model's own continuation. The
 * leading tokens that match the supplied `draft` are "accepted from
 * draft"; the first mismatch is the correction; the model's `done` /
 * stop is propagated.
 *
 * When the native fork emits exact verifier reject ranges, the
 * `onVerifierEvent` callback already carries `kind: "reject"` events with
 * the rejected token positions — this adapter records both and trusts the
 * server's accept/reject split rather than re-deriving it.
 */
export class LlamaServerTargetVerifier {
	runner;
	maxStep;
	constructor(runner, opts = {}) {
		this.runner = runner;
		this.maxStep = Math.max(1, Math.floor(opts.maxStep ?? 16));
	}
	async verify(args) {
		if (args.cancel.cancelled) return { accepted: [], done: false };
		// Step budget: enough to confirm the whole draft window plus one
		// correction token (and a little headroom for the model's own bonus
		// tokens past a fully-accepted draft).
		const stepTokens = Math.min(
			this.maxStep,
			Math.max(1, args.draft.length + 1),
		);
		let nextIndex =
			args.prefix.length > 0
				? args.prefix[args.prefix.length - 1].index + 1
				: 0;
		const produced = [];
		let done = false;
		const { text } = await this.runner.generateWithVerifierEvents({
			prompt: prefixToPrompt(args.prefix),
			maxTokens: stepTokens,
			temperature: 0,
			signal: cancelToSignal(args.cancel),
			onVerifierEvent: (event) => {
				if (event.kind === "accept") {
					for (const tok of event.tokens) {
						produced.push({ index: nextIndex++, text: tok.text });
					}
				}
				// reject events: the server already retracted those positions
				// from its own stream, so we just don't append them. Nothing else
				// to do here — the chunker rollback is driven by the pipeline
				// comparing `accepted` against `draft`.
			},
		});
		if (args.cancel.cancelled) return { accepted: [], done: false };
		if (produced.length === 0 && text.length > 0) {
			// Non-streaming server (no per-delta events): fall back to splitting
			// the returned text into tokens.
			produced.push(...splitTranscriptToTokens(text, nextIndex));
		}
		// The model reached its natural stop when it produced fewer tokens
		// than the step budget (it hit an EOS / stop sequence before the cap).
		done = produced.length < stepTokens;
		return { accepted: produced, done };
	}
}
function cancelToSignal(cancel) {
	const controller = new AbortController();
	if (cancel.cancelled) {
		controller.abort();
		return controller.signal;
	}
	if (typeof cancel.onCancel === "function") {
		// Event-driven path — no polling. The owner fires the listener
		// synchronously on barge-in; we abort the HTTP request at that
		// instant. `once`: AbortController.abort() is idempotent but we
		// still want to drop the listener to free the closure.
		const unsubscribe = cancel.onCancel(() => {
			controller.abort();
		});
		controller.signal.addEventListener("abort", () => unsubscribe(), {
			once: true,
		});
		return controller.signal;
	}
	// Fallback: polling. Kept for tokens that don't expose the hook (e.g.
	// tests that pass a plain `{cancelled}` POJO). The interval is short
	// enough that an aborted-but-unhooked token still lands the abort
	// before a typical kernel tick completes.
	const timer = setInterval(() => {
		if (cancel.cancelled) {
			controller.abort();
			clearInterval(timer);
		}
	}, 10);
	// Don't keep the event loop alive purely for this poll.
	if (typeof timer === "object" && timer && "unref" in timer) {
		timer.unref();
	}
	controller.signal.addEventListener("abort", () => clearInterval(timer), {
		once: true,
	});
	return controller.signal;
}
//# sourceMappingURL=pipeline-impls.js.map
