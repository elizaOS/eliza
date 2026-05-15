import { inferenceTelemetry } from "../inference-telemetry";
import { BargeInController } from "./barge-in";
import { PhraseCache } from "./phrase-cache";
import { PhraseChunker } from "./phrase-chunker";
import { PrefixPreservingQueue } from "./prefix-preserving-queue";
import { InMemoryAudioSink, PcmRingBuffer } from "./ring-buffer";
import { RollbackQueue } from "./rollback-queue";

const DEFAULT_MAX_IN_FLIGHT_PHRASES = 4;
function nowMs() {
	return globalThis.performance?.now?.() ?? Date.now();
}
function phraseTelemetry(phrase) {
	return {
		id: phrase.id,
		text: phrase.text,
		fromIndex: phrase.fromIndex,
		toIndex: phrase.toIndex,
		terminator: phrase.terminator,
		tokenCount: Math.max(0, phrase.toIndex - phrase.fromIndex + 1),
		textBytes: new TextEncoder().encode(phrase.text).length,
	};
}
function isStreamingTtsBackend(backend) {
	return typeof backend.synthesizeStream === "function";
}
function isNativeCancelableTtsBackend(backend) {
	return typeof backend.cancelTts === "function";
}
function copyPcm(pcm) {
	return new Float32Array(pcm);
}
function concatPcm(parts, total) {
	const out = new Float32Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}
export class VoiceScheduler {
	chunker;
	rollback = new RollbackQueue();
	bargeIn = new BargeInController();
	ringBuffer;
	sink;
	preset;
	/**
	 * Prefix-preserving barge-in queue. When the streaming TTS path is active,
	 * each audio chunk is enqueued here tagged with its token range. On
	 * hard-stop (barge-in), `rollbackAt(divergencePoint)` partitions the
	 * queue: chunks at or before the divergence point are replayed into the
	 * sink; chunks after are dropped. This lets audio that was already
	 * correct play through without re-synthesizing.
	 */
	prefixQueue = new PrefixPreservingQueue();
	backend;
	phraseCache;
	events;
	sampleRate;
	inFlight = new Map();
	maxInFlight;
	streamingTtsActive;
	kernelTicks = 0;
	nextStandalonePhraseId = -1;
	/** True while a provisional barge-in (`pause-tts`) has paused playback. */
	paused = false;
	/**
	 * The last committed token index — updated whenever a phrase is dispatched
	 * to TTS. Used as the divergence point when a barge-in fires mid-response.
	 */
	lastCommittedTokenIndex = 0;
	agentSpeakingUntilMs = 0;
	agentSpeakingTimer = null;
	phraseFlushTimer = null;
	constructor(config, deps, events = {}) {
		this.chunker = new PhraseChunker(
			config.chunkerConfig,
			deps.phonemeTokenizer ?? null,
		);
		this.preset = config.preset;
		this.backend = deps.backend;
		this.phraseCache = deps.phraseCache ?? new PhraseCache();
		this.sampleRate = config.sampleRate;
		this.sink = deps.sink ?? new InMemoryAudioSink();
		this.ringBuffer = new PcmRingBuffer(
			config.ringBufferCapacity,
			config.sampleRate,
			this.sink,
		);
		this.events = events;
		this.maxInFlight = Math.max(
			1,
			config.maxInFlightPhrases ?? DEFAULT_MAX_IN_FLIGHT_PHRASES,
		);
		// streamingTtsActive defaults true. The Metal ggml_conv_transpose_1d stall
		// that previously required disabling this on macOS is fixed in the
		// llama.cpp merge (native Metal kernels; CPU fallback no longer triggers).
		this.streamingTtsActive = config.streamingTtsActive ?? true;
		// Legacy hard-stop hook (`bargeIn.onMicActive()` / `attach.onCancel`).
		this.bargeIn.attach({
			onCancel: () => this.handleBargeIn(),
		});
		// New signal stream: pause/resume on a provisional barge-in, hard-stop
		// when ASR confirms words. (`onMicActive()` also emits `hard-stop`, so
		// `handleBargeIn` fires from both the legacy `attach` and here — it's
		// idempotent.)
		this.bargeIn.onSignal((signal) => this.onBargeInSignal(signal));
	}
	async accept(token, acceptedAt = Date.now()) {
		const acc = { ...token, acceptedAt };
		const phrase = this.chunker.push(acc);
		if (phrase) {
			this.clearPhraseFlushTimer();
			await this.dispatchPhrase(phrase);
			return;
		}
		this.armPhraseFlushTimer();
	}
	async reject(range) {
		// Drop draft tokens still sitting in the chunker's buffer (not yet
		// packed into a phrase) so the verifier's correction is not glued
		// onto stale text.
		this.chunker.dropPendingFrom(range.fromIndex);
		this.armPhraseFlushTimer();
		const events = this.rollback.onRejected(range);
		let cancelledStreamingInFlight = false;
		for (const ev of events) {
			const inflight = this.inFlight.get(ev.phraseId);
			if (inflight) {
				inflight.cancelSignal.cancelled = true;
				cancelledStreamingInFlight ||= isStreamingTtsBackend(this.backend);
				this.emitTtsCancel(inflight.phrase, "rollback");
			}
			this.rollback.drop(ev.phraseId);
			this.events.onRollback?.(ev.phraseId, range);
			this.emitTelemetry({
				type: "rollback",
				atMs: nowMs(),
				phraseId: ev.phraseId,
				range,
				reason: ev.reason,
			});
		}
		if (cancelledStreamingInFlight) {
			this.cancelNativeTts();
		}
	}
	async flushPending() {
		this.clearPhraseFlushTimer();
		const tail = this.chunker.flushPending();
		if (tail) {
			await this.dispatchPhrase(tail);
		}
	}
	async waitIdle() {
		const all = Array.from(this.inFlight.values()).map((i) => i.done);
		await Promise.all(all);
	}
	async synthesizeText(text, signal) {
		const phrase = {
			id: this.nextStandalonePhraseId--,
			text,
			fromIndex: 0,
			toIndex: 0,
			terminator: "max-cap",
		};
		if (signal?.aborted) {
			this.emitTtsCancel(phrase, "synthesis-cancelled");
			throw new Error("[voice-scheduler] synthesis cancelled by abort signal");
		}
		const cached = this.phraseCache.get(text);
		if (cached) {
			this.emitTelemetry({
				type: "phrase-cache-hit",
				atMs: nowMs(),
				phrase: phraseTelemetry(phrase),
			});
			this.emitTelemetry({
				type: "tts-first-audio",
				atMs: nowMs(),
				phrase: phraseTelemetry(phrase),
				source: "cache",
				samples: cached.pcm.length,
				sampleRate: cached.sampleRate,
			});
			return {
				phraseId: phrase.id,
				fromIndex: phrase.fromIndex,
				toIndex: phrase.toIndex,
				pcm: cached.pcm,
				sampleRate: cached.sampleRate,
			};
		}
		this.emitTelemetry({
			type: "phrase-cache-miss",
			atMs: nowMs(),
			phrase: phraseTelemetry(phrase),
		});
		const cancelSignal = { cancelled: false };
		const abort = () => {
			cancelSignal.cancelled = true;
			this.cancelNativeTts();
		};
		if (signal?.aborted) {
			abort();
		}
		signal?.addEventListener("abort", abort, { once: true });
		const detach = this.bargeIn.attach({
			onCancel: () => {
				cancelSignal.cancelled = true;
			},
		});
		try {
			this.emitTelemetry({
				type: "tts-start",
				atMs: nowMs(),
				phrase: phraseTelemetry(phrase),
				inFlightPhrases: this.inFlight.size,
			});
			const chunk = await this.backend.synthesize({
				phrase,
				preset: this.preset,
				cancelSignal,
				onKernelTick: () => this.tickKernel(),
			});
			if (cancelSignal.cancelled) {
				this.emitTtsCancel(phrase, "synthesis-cancelled");
				throw new Error("[voice-scheduler] synthesis cancelled by barge-in");
			}
			this.emitTelemetry({
				type: "tts-first-audio",
				atMs: nowMs(),
				phrase: phraseTelemetry(phrase),
				source: "synthesis",
				samples: chunk.pcm.length,
				sampleRate: chunk.sampleRate,
			});
			this.phraseCache.put({
				text,
				pcm: chunk.pcm,
				sampleRate: chunk.sampleRate,
			});
			return chunk;
		} finally {
			detach();
			signal?.removeEventListener("abort", abort);
		}
	}
	async prewarmPhrases(texts, opts = {}) {
		const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));
		let warmed = 0;
		let cached = 0;
		let cursor = 0;
		const worker = async () => {
			for (;;) {
				const index = cursor++;
				if (index >= texts.length) return;
				const text = texts[index]?.trim();
				if (!text) continue;
				if (this.phraseCache.has(text)) {
					cached++;
					continue;
				}
				const phrase = {
					id: this.nextStandalonePhraseId--,
					text,
					fromIndex: 0,
					toIndex: 0,
					terminator: "max-cap",
				};
				const chunk = await this.backend.synthesize({
					phrase,
					preset: this.preset,
					cancelSignal: { cancelled: false },
					onKernelTick: () => this.tickKernel(),
				});
				const stored = this.phraseCache.put({
					text,
					pcm: chunk.pcm,
					sampleRate: chunk.sampleRate,
				});
				if (stored) warmed++;
			}
		};
		await Promise.all(
			Array.from({ length: Math.min(concurrency, texts.length) }, () =>
				worker(),
			),
		);
		return { warmed, cached };
	}
	tickKernel() {
		this.kernelTicks++;
	}
	kernelTickCount() {
		return this.kernelTicks;
	}
	/**
	 * Mark the agent as audibly speaking for the duration of audio handed to the
	 * sink. This is the barge-in gate: VAD blips only pause/resume TTS while this
	 * flag is true, and ASR-confirmed words hard-stop playback plus generation.
	 */
	markAgentSpeakingForAudio(samples, sampleRate) {
		if (samples <= 0 || sampleRate <= 0) return;
		const durationMs = (samples / sampleRate) * 1000;
		// A short guard absorbs sink scheduling jitter between tiny streaming chunks.
		this.agentSpeakingUntilMs = Math.max(
			this.agentSpeakingUntilMs,
			nowMs() + durationMs + 50,
		);
		this.bargeIn.setAgentSpeaking(true);
		this.armAgentSpeakingTimer();
	}
	/** True while a provisional barge-in has paused TTS playback. */
	get ttsPaused() {
		return this.paused;
	}
	/**
	 * Drop not-yet-spoken TTS without signalling a barge-in: drain the ring
	 * buffer, reset the chunker, cancel in-flight synthesis. Used by the turn
	 * controller when a speculative response is invalidated (speech resumed) —
	 * the speculative TTS was streamed off a stale partial transcript, so it
	 * must go, but this is not a user barge-in (`onCancel` is NOT fired).
	 */
	cancelPendingTts() {
		this.paused = false;
		this.clearAgentSpeaking();
		this.clearPhraseFlushTimer();
		this.ringBuffer.drain();
		this.prefixQueue.clear();
		this.lastCommittedTokenIndex = 0;
		this.chunker.reset();
		for (const inflight of this.inFlight.values()) {
			inflight.cancelSignal.cancelled = true;
			this.emitTtsCancel(inflight.phrase, "pending-tts");
		}
		this.cancelNativeTts();
	}
	async dispatchPhrase(phrase) {
		this.rollback.track(phrase);
		// Advance the divergence-point cursor. Tokens up to toIndex are now
		// "committed" — a barge-in rollback keeps audio for them.
		this.lastCommittedTokenIndex = Math.max(
			this.lastCommittedTokenIndex,
			phrase.toIndex,
		);
		this.events.onPhrase?.(phrase);
		this.emitTelemetry({
			type: "phrase-dispatch",
			atMs: nowMs(),
			phrase: phraseTelemetry(phrase),
			inFlightPhrases: this.inFlight.size,
		});
		const cached = this.phraseCache.get(phrase.text);
		if (cached) {
			this.emitTelemetry({
				type: "phrase-cache-hit",
				atMs: nowMs(),
				phrase: phraseTelemetry(phrase),
			});
			const chunk = {
				phraseId: phrase.id,
				fromIndex: phrase.fromIndex,
				toIndex: phrase.toIndex,
				pcm: cached.pcm,
				sampleRate: cached.sampleRate,
			};
			this.commitAudio(chunk, phrase, "cache");
			return;
		}
		this.emitTelemetry({
			type: "phrase-cache-miss",
			atMs: nowMs(),
			phrase: phraseTelemetry(phrase),
		});
		if (this.inFlight.size >= this.maxInFlight) {
			const oldest = this.inFlight.values().next().value;
			if (oldest) {
				await oldest.done;
			}
		}
		const cancelSignal = { cancelled: false };
		let resolveDone;
		let rejectDone;
		const done = new Promise((resolve, reject) => {
			resolveDone = resolve;
			rejectDone = reject;
		});
		this.inFlight.set(phrase.id, { phrase, cancelSignal, done });
		void this.runPhraseSynthesis(phrase, cancelSignal).then(
			resolveDone,
			rejectDone,
		);
	}
	async runPhraseSynthesis(phrase, cancelSignal) {
		try {
			this.rollback.markSynthesizing(phrase.id);
			this.emitTelemetry({
				type: "tts-start",
				atMs: nowMs(),
				phrase: phraseTelemetry(phrase),
				inFlightPhrases: this.inFlight.size,
			});
			if (this.streamingTtsActive && isStreamingTtsBackend(this.backend)) {
				const cancelled = await this.synthesizePhraseStream(
					phrase,
					cancelSignal,
				);
				if (cancelled || cancelSignal.cancelled) {
					this.emitTtsCancel(phrase, "synthesis-cancelled");
				}
				return;
			}
			const chunk = await this.backend.synthesize({
				phrase,
				preset: this.preset,
				cancelSignal,
				onKernelTick: () => this.tickKernel(),
			});
			if (cancelSignal.cancelled) {
				this.emitTtsCancel(phrase, "synthesis-cancelled");
				return;
			}
			if (!this.isPhraseTracked(phrase.id)) {
				return;
			}
			this.phraseCache.put({
				text: phrase.text,
				pcm: chunk.pcm,
				sampleRate: chunk.sampleRate,
			});
			this.commitAudio(chunk, phrase, "synthesis");
		} finally {
			this.inFlight.delete(phrase.id);
		}
	}
	async synthesizePhraseStream(phrase, cancelSignal) {
		const backend = this.backend;
		if (!isStreamingTtsBackend(backend)) return false;
		const parts = [];
		let totalSamples = 0;
		let sampleRate = 0;
		let firstAudio = true;
		// T2 — per-chunk size distribution. Float32 samples => 4 bytes/sample.
		const chunkSamples = [];
		const result = await backend.synthesizeStream({
			phrase,
			preset: this.preset,
			cancelSignal,
			onKernelTick: () => this.tickKernel(),
			onChunk: (chunk) => {
				if (cancelSignal.cancelled || !this.isPhraseTracked(phrase.id)) {
					return true;
				}
				if (chunk.isFinal || chunk.pcm.length === 0) {
					return cancelSignal.cancelled;
				}
				const pcm = copyPcm(chunk.pcm);
				parts.push(pcm);
				totalSamples += pcm.length;
				sampleRate = chunk.sampleRate;
				chunkSamples.push({
					samples: pcm.length,
					sampleRate: chunk.sampleRate,
				});
				// T2 — emit per-chunk metrics so consumers can detect whether TTS is
				// streaming short chunks (good) or batching whole phrases (bad). The
				// backend constructor name is the cheapest available identity label
				// without threading a separate config field.
				const chunkDurationMs =
					chunk.sampleRate > 0 ? (pcm.length / chunk.sampleRate) * 1000 : 0;
				const ttsBackendName = backend.constructor.name;
				inferenceTelemetry.record("tts.chunk_size_ms", chunkDurationMs, {
					backend: ttsBackendName,
				});
				inferenceTelemetry.record(
					"tts.chunk_size_bytes",
					pcm.length * 4, // Float32: 4 bytes per sample
					{ backend: ttsBackendName },
				);
				// Tag the chunk with its phrase token range and enqueue it for
				// prefix-preserving barge-in rollback. The chunk covers the full
				// phrase range — sub-phrase token attribution is not available from
				// the streaming TTS ABI, so all chunks of a phrase carry the same
				// [fromIndex, toIndex]. Rollback at phrase granularity is still a
				// large improvement over dropping all in-flight audio.
				const taggedChunk = {
					pcm,
					tokenRange: [phrase.fromIndex, phrase.toIndex],
					durationMs: chunkDurationMs,
				};
				this.prefixQueue.enqueue(taggedChunk);
				this.commitAudio(
					{
						phraseId: phrase.id,
						fromIndex: phrase.fromIndex,
						toIndex: phrase.toIndex,
						pcm,
						sampleRate: chunk.sampleRate,
					},
					phrase,
					"synthesis",
					{ emitFirstAudio: firstAudio, markPlayed: false },
				);
				firstAudio = false;
				return cancelSignal.cancelled;
			},
		});
		const cancelled = result.cancelled || cancelSignal.cancelled;
		if (!cancelled && this.isPhraseTracked(phrase.id)) {
			this.rollback.markPlayed(phrase.id);
			if (totalSamples > 0) {
				this.phraseCache.put({
					text: phrase.text,
					pcm: concatPcm(parts, totalSamples),
					sampleRate,
				});
			}
		}
		// T2 — fire the chunk-size telemetry callback. Done unconditionally so
		// a cancelled phrase still reports what it did stream (helps debug
		// barge-in latency). Float32 samples occupy 4 bytes each.
		if (this.events.onChunkMetrics) {
			const chunks = chunkSamples.map((c) => ({
				chunkBytes: c.samples * 4,
				chunkDurationMs:
					c.sampleRate > 0 ? (c.samples / c.sampleRate) * 1000 : 0,
			}));
			let totalDurationMs = 0;
			let totalBytes = 0;
			for (const c of chunks) {
				totalDurationMs += c.chunkDurationMs;
				totalBytes += c.chunkBytes;
			}
			this.events.onChunkMetrics({
				phraseId: phrase.id,
				chunks,
				totalDurationMs,
				totalBytes,
				cancelled,
			});
		}
		return cancelled;
	}
	isPhraseTracked(phraseId) {
		return this.rollback
			.snapshot()
			.some((entry) => entry.phrase.id === phraseId);
	}
	cancelNativeTts() {
		if (isNativeCancelableTtsBackend(this.backend)) {
			this.backend.cancelTts();
		}
	}
	commitAudio(chunk, phrase, source, opts = {}) {
		if (opts.emitFirstAudio !== false) {
			this.emitTelemetry({
				type: "tts-first-audio",
				atMs: nowMs(),
				phrase: phraseTelemetry(phrase),
				source,
				samples: chunk.pcm.length,
				sampleRate: chunk.sampleRate,
			});
		}
		this.rollback.markRingBuffered(chunk.phraseId);
		this.ringBuffer.write(chunk.pcm);
		// When TTS is paused by a provisional barge-in, keep the synthesized
		// PCM in the ring buffer but DON'T hand it to the sink yet — `resume-tts`
		// flushes it; `hard-stop` drains it.
		let flushedSamples = 0;
		if (!this.paused) {
			flushedSamples = this.ringBuffer.flushToSink();
			this.markAgentSpeakingForAudio(flushedSamples, chunk.sampleRate);
		}
		if (opts.markPlayed !== false) {
			this.rollback.markPlayed(chunk.phraseId);
		}
		this.emitTelemetry({
			type: "audio-committed",
			atMs: nowMs(),
			phrase: phraseTelemetry(phrase),
			source,
			samples: chunk.pcm.length,
			sampleRate: chunk.sampleRate,
			flushedSamples,
			paused: this.paused,
			ringBufferSamples: this.ringBuffer.size(),
			sinkBufferedSamples: this.sink.bufferedSamples(),
		});
		this.events.onAudio?.(chunk);
	}
	onBargeInSignal(signal) {
		switch (signal.type) {
			case "pause-tts": {
				if (!this.paused) {
					this.paused = true;
					this.events.onTtsPause?.();
				}
				break;
			}
			case "resume-tts": {
				if (this.paused) {
					this.paused = false;
					// Hand whatever was buffered during the pause to the sink now.
					if (this.ringBuffer.size() > 0) {
						const flushed = this.ringBuffer.flushToSink();
						this.markAgentSpeakingForAudio(flushed, this.sampleRate);
					}
					this.events.onTtsResume?.();
				}
				break;
			}
			case "hard-stop":
				// Handled by the legacy `attach.onCancel` hook registered in the
				// constructor — `BargeInController.hardStop()` fires both the
				// `attach` listeners and `onSignal(hard-stop)`, so doing the
				// ring-buffer drain again here would double-fire `onCancel`. The
				// engine layer subscribes to `onSignal(hard-stop)` separately to
				// thread `signal.token.signal` into `dispatcher.generate`.
				break;
		}
	}
	handleBargeIn() {
		const ringBufferSamplesDrained = this.ringBuffer.size();
		const sinkBufferedSamplesDrained = this.sink.bufferedSamples();
		const wasPaused = this.paused;
		const inFlightPhrases = Array.from(this.inFlight.values());
		const divergencePoint = this.lastCommittedTokenIndex;
		this.paused = false;
		this.clearAgentSpeaking();
		this.clearPhraseFlushTimer();
		// Prefix-preserving rollback: partition in-flight audio chunks at the
		// divergence point. Chunks for tokens <= divergencePoint are replayed
		// into the sink (they were already correct); the rest are dropped.
		// This avoids re-synthesizing audio the user would have heard anyway.
		//
		// If the prefix queue is empty (e.g. the backend emitted no streaming
		// chunks yet), fall through to the plain drain path.
		const prefixResult = this.prefixQueue.rollbackAt(divergencePoint);
		if (prefixResult.retained.length > 0 || prefixResult.dropped.length > 0) {
			// We had tagged chunks — apply prefix-preserving rollback.
			// Drain the ring buffer first (it may hold chunks we're about to
			// replay from the retained prefix, or chunks past the cutoff).
			this.ringBuffer.drain();
			// Replay retained prefix into the ring buffer and flush to sink.
			for (const taggedChunk of prefixResult.retained) {
				this.ringBuffer.write(taggedChunk.pcm);
			}
			if (prefixResult.retained.length > 0) {
				const flushed = this.ringBuffer.flushToSink();
				this.markAgentSpeakingForAudio(flushed, this.sampleRate);
			}
			this.emitTelemetry({
				type: "barge-in-prefix-rollback",
				atMs: nowMs(),
				divergencePoint,
				retainedChunks: prefixResult.retained.length,
				droppedChunks: prefixResult.dropped.length,
				straddledChunks: prefixResult.straddled.length,
				retainedDurationMs: prefixResult.retainedDurationMs,
				droppedDurationMs: prefixResult.droppedDurationMs,
			});
		} else {
			// No tagged chunks — plain ring-buffer drain (legacy path).
			this.ringBuffer.drain();
		}
		this.chunker.reset();
		this.lastCommittedTokenIndex = 0;
		for (const inflight of inFlightPhrases) {
			inflight.cancelSignal.cancelled = true;
			this.emitTtsCancel(inflight.phrase, "barge-in");
		}
		this.cancelNativeTts();
		this.emitTelemetry({
			type: "barge-in",
			atMs: nowMs(),
			ringBufferSamplesDrained,
			sinkBufferedSamplesDrained,
			inFlightPhrasesCancelled: inFlightPhrases.length,
			wasPaused,
		});
		this.events.onCancel?.();
	}
	emitTtsCancel(phrase, reason) {
		this.emitTelemetry({
			type: "tts-cancel",
			atMs: nowMs(),
			phrase: phraseTelemetry(phrase),
			reason,
		});
	}
	emitTelemetry(event) {
		this.events.onTelemetry?.(event);
	}
	armPhraseFlushTimer() {
		this.clearPhraseFlushTimer();
		const delayMs = this.chunker.msUntilTimeBudget();
		if (!Number.isFinite(delayMs)) return;
		this.phraseFlushTimer = setTimeout(
			() => {
				this.phraseFlushTimer = null;
				const phrase = this.chunker.flushIfTimeBudgetExceeded();
				if (!phrase) {
					this.armPhraseFlushTimer();
					return;
				}
				void this.dispatchPhrase(phrase).catch((err) => {
					setTimeout(() => {
						throw err;
					}, 0);
				});
			},
			Math.max(0, delayMs),
		);
	}
	clearPhraseFlushTimer() {
		if (this.phraseFlushTimer) {
			clearTimeout(this.phraseFlushTimer);
			this.phraseFlushTimer = null;
		}
	}
	armAgentSpeakingTimer() {
		if (this.agentSpeakingTimer) {
			clearTimeout(this.agentSpeakingTimer);
			this.agentSpeakingTimer = null;
		}
		const delayMs = Math.max(1, this.agentSpeakingUntilMs - nowMs());
		this.agentSpeakingTimer = setTimeout(() => {
			this.agentSpeakingTimer = null;
			if (nowMs() < this.agentSpeakingUntilMs) {
				this.armAgentSpeakingTimer();
				return;
			}
			this.agentSpeakingUntilMs = 0;
			if (this.ringBuffer.size() === 0) {
				this.bargeIn.setAgentSpeaking(false);
			}
		}, delayMs);
		const maybeUnref = this.agentSpeakingTimer;
		maybeUnref.unref?.();
	}
	clearAgentSpeaking() {
		this.agentSpeakingUntilMs = 0;
		if (this.agentSpeakingTimer) {
			clearTimeout(this.agentSpeakingTimer);
			this.agentSpeakingTimer = null;
		}
		this.bargeIn.setAgentSpeaking(false);
	}
}
//# sourceMappingURL=scheduler.js.map
