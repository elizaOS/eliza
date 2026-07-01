/**
 * On-device "grind all models" telemetry self-test.
 *
 * Loads and exercises every local Eliza-1 model reachable from the iOS native
 * bridge (text LLM + MTP, TTS, ASR) and emits per-model + overall timing and
 * pass/fail telemetry. The TTS→ASR round-trip (with WER) is the gold check that
 * both the synthesis and recognition paths produce correct output end to end.
 *
 * Per-model error capture is intentional: the whole point of a grind self-test
 * is to report WHICH models fail, not to abort on the first failure.
 *
 * Deps are injected from `ios/bridge.ts` (the native helpers are module-private
 * there), keeping this orchestration testable and free of native coupling.
 */

export interface ModelGrindDeps {
	callIosHost: (
		method: string,
		payload: unknown,
		timeoutMs?: number,
	) => Promise<unknown>;
	/** Load the GGUF for a slot ("TEXT_SMALL" | "TEXT_LARGE"); resolves when warm. */
	ensureTextModelLoaded: (slot: string) => Promise<unknown>;
	/** Synthesize speech, returns WAV bytes + sampleRate. */
	synthesizeTts: (
		text: string,
	) => Promise<{ bytes: Uint8Array; sampleRate: number }>;
	/** Transcribe mono PCM (any rate); returns the transcript. */
	transcribeAsr: (pcm: number[], sampleRate: number) => Promise<string>;
	/** Native hardware/memory probe (total_ram_gb, available_ram_gb, ...). */
	hardwareInfo: () => Promise<Record<string, unknown>>;
	bundleDir: string | null;
}

export interface ModelGrindResult {
	model: string;
	ok: boolean;
	loadMs?: number;
	inferMs?: number;
	firstResultMs?: number;
	throughput?: { kind: "tokens_per_sec" | "rtf" | "wer"; value: number };
	detail?: Record<string, unknown>;
	loadDetail?: Record<string, unknown>;
	error?: string;
}

export interface ModelGrindReport {
	startedAtEpochMs: number;
	finishedAtEpochMs: number;
	totalMs: number;
	bundleDir: string | null;
	device: Record<string, unknown>;
	memory: {
		beforeAvailGb: number | null;
		afterAvailGb: number | null;
		peakUsedDeltaGb: number | null;
	};
	models: ModelGrindResult[];
	overall: { allPassed: boolean; passed: number; failed: number };
}

const GRIND_PHRASE = "Eliza local voice end to end check, one two three.";

function now(): number {
	// performance.now() is monotonic; epoch via Date is only used for stamps.
	return typeof performance !== "undefined"
		? performance.now()
		: Number(process.hrtime.bigint() / 1_000_000n);
}

/**
 * Word error rate via token Levenshtein (lowercased, punctuation-stripped).
 *
 * Intentionally ASCII-only: the normalizer collapses everything outside
 * `[a-z0-9]` to whitespace, so apostrophes and non-ASCII letters are dropped.
 * That is fine here because the grind self-test compares against a fixed ASCII
 * English phrase (`GRIND_PHRASE`). The canonical, Unicode-aware WER used
 * elsewhere lives in `@elizaos/shared/voice-wer`; this local copy stays
 * dependency-free so the mobile bridge bundle does not pull in `@elizaos/shared`.
 */
export function wordErrorRate(reference: string, hypothesis: string): number {
	const norm = (s: string): string[] =>
		s
			.toLowerCase()
			.replace(/[^a-z0-9\s]/g, " ")
			.split(/\s+/)
			.filter(Boolean);
	const ref = norm(reference);
	const hyp = norm(hypothesis);
	if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
	const dp: number[] = Array.from({ length: hyp.length + 1 }, (_v, j) => j);
	for (let i = 1; i <= ref.length; i++) {
		let prev = dp[0];
		dp[0] = i;
		for (let j = 1; j <= hyp.length; j++) {
			const tmp = dp[j];
			dp[j] =
				ref[i - 1] === hyp[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
			prev = tmp;
		}
	}
	return dp[hyp.length] / ref.length;
}

/** Parse a PCM WAV (int16 or float32) to a mono Float-ish number[] in [-1,1]. */
export function decodeWavToPcm(bytes: Uint8Array): {
	pcm: number[];
	sampleRate: number;
} {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (bytes.length < 44 || view.getUint32(0, false) !== 0x52494646 /* RIFF */) {
		throw new Error("not a RIFF/WAV payload");
	}
	let offset = 12;
	let fmt = 1;
	let channels = 1;
	let sampleRate = 24_000;
	let bitsPerSample = 16;
	let dataOffset = -1;
	let dataLen = 0;
	while (offset + 8 <= bytes.length) {
		const id = view.getUint32(offset, false);
		const size = view.getUint32(offset + 4, true);
		const body = offset + 8;
		if (id === 0x666d7420 /* "fmt " */) {
			fmt = view.getUint16(body, true);
			channels = view.getUint16(body + 2, true) || 1;
			sampleRate = view.getUint32(body + 4, true) || 24_000;
			bitsPerSample = view.getUint16(body + 14, true) || 16;
		} else if (id === 0x64617461 /* "data" */) {
			dataOffset = body;
			dataLen = size;
		}
		offset = body + size + (size % 2);
	}
	if (dataOffset < 0) throw new Error("WAV has no data chunk");
	const pcm: number[] = [];
	const isFloat = fmt === 3 || bitsPerSample === 32;
	const step = (bitsPerSample / 8) * channels;
	for (
		let p = dataOffset;
		p + step <= dataOffset + dataLen && p + step <= bytes.length;
		p += step
	) {
		const sample = isFloat
			? view.getFloat32(p, true)
			: view.getInt16(p, true) / 32_768;
		pcm.push(sample); // channel 0 only (mono assumption for ASR)
	}
	return { pcm, sampleRate };
}

/** Linear resample mono PCM to a target rate. */
export function resamplePcm(pcm: number[], from: number, to: number): number[] {
	if (from === to || pcm.length === 0) return pcm;
	const ratio = to / from;
	const out: number[] = new Array(Math.max(1, Math.floor(pcm.length * ratio)));
	for (let i = 0; i < out.length; i++) {
		const src = i / ratio;
		const i0 = Math.floor(src);
		const i1 = Math.min(pcm.length - 1, i0 + 1);
		const frac = src - i0;
		out[i] = pcm[i0] * (1 - frac) + pcm[i1] * frac;
	}
	return out;
}

function availGb(hw: Record<string, unknown>): number | null {
	const v = Number(hw.available_ram_gb ?? hw.free_ram_gb ?? NaN);
	return Number.isFinite(v) ? v : null;
}

export async function runModelGrind(
	deps: ModelGrindDeps,
): Promise<ModelGrindReport> {
	const startedAtEpochMs = Date.now();
	const t0 = now();
	const models: ModelGrindResult[] = [];

	let device: Record<string, unknown> = {};
	let beforeAvailGb: number | null = null;
	try {
		device = await deps.hardwareInfo();
		beforeAvailGb = availGb(device);
	} catch (error) {
		device = { error: error instanceof Error ? error.message : String(error) };
	}
	let minAvailGb = beforeAvailGb;
	const trackMem = async (): Promise<void> => {
		try {
			const a = availGb(await deps.hardwareInfo());
			if (a !== null && (minAvailGb === null || a < minAvailGb)) minAvailGb = a;
		} catch {
			/* memory probe is best-effort telemetry */
		}
	};

	// ── 1. Text LLM (load + generate, MTP if available) ─────────────────────
	{
		const r: ModelGrindResult = { model: "text", ok: false };
		// Per-model memory + load telemetry to localize the on-device load hang.
		let availPreLoad: number | null = null;
		try {
			availPreLoad = availGb(await deps.hardwareInfo());
		} catch {
			/* probe */
		}
		try {
			const lt = now();
			const state = (await deps.ensureTextModelLoaded("TEXT_SMALL")) as {
				contextId?: unknown;
			};
			const contextId =
				typeof state.contextId === "number" && Number.isFinite(state.contextId)
					? state.contextId
					: null;
			if (contextId == null) {
				throw new Error("Text model load returned no contextId");
			}
			r.loadMs = Math.round(now() - lt);
			let availPostLoad: number | null = null;
			try {
				availPostLoad = availGb(await deps.hardwareInfo());
			} catch {
				/* probe */
			}
			r.loadDetail = {
				loadResult: state,
				availPreLoadGb: availPreLoad,
				availPostLoadGb: availPostLoad,
				loadUsedGb:
					availPreLoad !== null && availPostLoad !== null
						? Math.round((availPreLoad - availPostLoad) * 1000) / 1000
						: null,
			};
			const gt = now();
			const res = (await deps.callIosHost(
				"llama_generate",
				{
					context_id: contextId,
					prompt:
						"<start_of_turn>user\nSay hello in one short sentence.<end_of_turn>\n<start_of_turn>model\n",
					max_tokens: 48,
					temperature: 0.7,
					top_p: 0.9,
					top_k: 40,
					stop: ["<end_of_turn>", "<start_of_turn>", "<endoftext>"],
				},
				120_000,
			)) as Record<string, unknown>;
			r.inferMs = Math.round(now() - gt);
			const outTokens = Number(res.outputTokens ?? res.tokens ?? 0);
			const text = String(res.text ?? "");
			const tps = r.inferMs > 0 ? (outTokens * 1000) / r.inferMs : 0;
			r.throughput = {
				kind: "tokens_per_sec",
				value: Math.round(tps * 10) / 10,
			};
			r.detail = {
				outputTokens: outTokens,
				sample: text.slice(0, 120),
				mtp: res.specAccepted ?? res.mtpAccepted ?? null,
			};
			r.ok = outTokens > 0 && text.trim().length > 0;
			if (!r.ok) r.error = "text model returned empty output";
		} catch (error) {
			r.error = error instanceof Error ? error.message : String(error);
			// Record pre-load memory + loadMs even on a load hang/timeout (the
			// failure case we most want to localize).
			let availAtFail: number | null = null;
			try {
				availAtFail = availGb(await deps.hardwareInfo());
			} catch {
				/* probe */
			}
			r.loadDetail = r.loadDetail ?? {
				availPreLoadGb: availPreLoad,
				availAtFailureGb: availAtFail,
				usedBeforeFailureGb:
					availPreLoad !== null && availAtFail !== null
						? Math.round((availPreLoad - availAtFail) * 1000) / 1000
						: null,
			};
		}
		await trackMem();
		models.push(r);
	}

	// ── 2. TTS (synthesize; RTF) ────────────────────────────────────────────
	let ttsWav: { bytes: Uint8Array; sampleRate: number } | null = null;
	{
		const r: ModelGrindResult = { model: "tts", ok: false };
		try {
			const st = now();
			ttsWav = await deps.synthesizeTts(GRIND_PHRASE);
			r.inferMs = Math.round(now() - st);
			const { pcm, sampleRate } = decodeWavToPcm(ttsWav.bytes);
			const audioSec = pcm.length / sampleRate;
			const rtf = audioSec > 0 ? r.inferMs / 1000 / audioSec : 0;
			r.throughput = { kind: "rtf", value: Math.round(rtf * 1000) / 1000 };
			r.detail = {
				audioSec: Math.round(audioSec * 100) / 100,
				samples: pcm.length,
				sampleRate,
			};
			r.ok = pcm.length > sampleRate * 0.3 && audioSec > 0.3; // produced real audio
			if (!r.ok) r.error = "TTS produced too little audio";
		} catch (error) {
			r.error = error instanceof Error ? error.message : String(error);
		}
		await trackMem();
		models.push(r);
	}

	// ── 3. ASR round-trip (TTS → ASR; WER) ──────────────────────────────────
	{
		const r: ModelGrindResult = { model: "asr", ok: false };
		try {
			if (!ttsWav) throw new Error("no TTS audio to transcribe (TTS failed)");
			const { pcm, sampleRate } = decodeWavToPcm(ttsWav.bytes);
			const pcm16k = resamplePcm(pcm, sampleRate, 16_000);
			const at = now();
			const transcript = await deps.transcribeAsr(pcm16k, 16_000);
			r.inferMs = Math.round(now() - at);
			const wer = wordErrorRate(GRIND_PHRASE, transcript);
			r.throughput = { kind: "wer", value: Math.round(wer * 1000) / 1000 };
			r.detail = { reference: GRIND_PHRASE, hypothesis: transcript, wer };
			r.ok = transcript.trim().length > 0 && wer <= 0.5; // round-trip recognizable
			if (!r.ok)
				r.error = `ASR round-trip WER too high (${wer.toFixed(2)}) or empty`;
		} catch (error) {
			r.error = error instanceof Error ? error.message : String(error);
		}
		await trackMem();
		models.push(r);
	}

	let afterAvailGb: number | null = null;
	try {
		afterAvailGb = availGb(await deps.hardwareInfo());
	} catch {
		/* best-effort */
	}
	const peakUsedDeltaGb =
		beforeAvailGb !== null && minAvailGb !== null
			? Math.round((beforeAvailGb - minAvailGb) * 1000) / 1000
			: null;

	const passed = models.filter((m) => m.ok).length;
	const finishedAtEpochMs = Date.now();
	return {
		startedAtEpochMs,
		finishedAtEpochMs,
		totalMs: Math.round(now() - t0),
		bundleDir: deps.bundleDir,
		device,
		memory: { beforeAvailGb, afterAvailGb, peakUsedDeltaGb },
		models,
		overall: {
			allPassed: passed === models.length,
			passed,
			failed: models.length - passed,
		},
	};
}
