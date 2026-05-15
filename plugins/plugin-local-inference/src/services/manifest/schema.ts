// Eliza-1 manifest schema (`eliza-1.manifest.json`).
//
// Source of truth in this checkout: this file (the schema) and the sibling
// `eliza-1.manifest.v1.json` JSON Schema. The upstream elizaOS source has
// a longer prose specification under `packages/inference/AGENTS.md` (§6
// manifest, §3 mandatory kernels, §2 bundle/tier matrix); that file does
// not exist in the milady checkout — when editing the schema, treat the
// Zod definitions below as canonical and consult R5-versioning.md §1 for
// the latest gap analysis between bundle and per-sub-model versioning.
//
// Coupling notes:
// - The kernel names here are *manifest-level* capabilities (what the bundle
//   advertises), not the lower-level llama.cpp kernel handles in `../types.ts`
//   (`turbo3` / `turbo4` / `turbo3_tcq` / `qjl_full` / `dflash`). The two
//   layers map but are not the same enum.
// - The schema URL `https://elizaos.ai/schemas/eliza-1.manifest.v1.json` is
//   exported as a JSON Schema sibling file in this directory.
// - Shared-vocabulary invariant: every speculative-decoding GGUF in an
//   Eliza-1 bundle — the text/vision model and the DFlash drafter — shares
//   the same Eliza-1 BPE vocabulary and merges table. This is what makes
//   (a) DFlash speculative decoding correct (spec decoding only works if token
//   ids match), and (b) the drafter GGUFs ship without
//   their own `tokenizer.ggml.merges` (repaired at load time from the text GGUF
//   by `resolveDflashDrafter` in `../dflash-server.ts`). The shared *vocabulary*
//   is not the same thing as a shared *token-embedding tensor*: each component
//   carries its own `token_embd.weight` (different fine-tunes, often different
//   hidden sizes), so the vocab matrix is duplicated per GGUF and cannot be
//   deduplicated without a fused-architecture container — out of scope. See
//   `plugins/plugin-local-inference/native/reports/porting/2026-05-11/` for
//   the in-tree porting reports.
// - Per-sub-model versioning (kokoro, omnivoice, turn-detector, voice-emotion,
//   diarizer, speaker-encoder, vad, wakeword, embedding, asr) lives in
//   `packages/shared/src/local-inference/voice-models.ts` and the matching
//   `models/voice/CHANGELOG.md`. The bundle manifest below ships the *current*
//   per-tier set of files; the voice-models module ships the *history* the
//   auto-updater walks.

import type { LocalRuntimeKernel } from "@elizaos/shared";
import { z } from "zod";

export const ELIZA_1_MANIFEST_SCHEMA_VERSION = "1" as const;
export const ELIZA_1_MANIFEST_SCHEMA_URL =
	"https://elizaos.ai/schemas/eliza-1.manifest.v1.json" as const;

// The shared Eliza-1 BPE vocabulary every text/drafter component in an
// Eliza-1 bundle uses. Exported so runtime code can assert it.
export const ELIZA_1_TOKENIZER_FAMILY = "qwen35" as const;
export const ELIZA_1_TOKENIZER_VOCAB_SIZE = 248_320 as const;

// Tiers — size-ordered across the active Eliza-1 bundles.
export const ELIZA_1_TIERS = [
	"0_8b",
	"2b",
	"4b",
	"9b",
	"27b",
	"27b-256k",
] as const;
export type Eliza1Tier = (typeof ELIZA_1_TIERS)[number];

// Manifest-level kernel capability names. Per AGENTS.md §3:
// `turboquant_q3`, `turboquant_q4`, `qjl`, `polarquant`, `dflash` are
// the named optimizations the bundle declares. `turbo3_tcq` is required
// for any long-context text variant. The C-level llama.cpp kernel handles in
// `../types.ts` are an implementation detail of the runtime; the manifest
// speaks in terms of the optimization, not the .metal/.comp file.
//
// The relationship to the runtime-side `LocalRuntimeKernel` enum (the
// llama.cpp-handle layer, declared in `@elizaos/shared/local-inference/types`)
// is made explicit by `ELIZA1_TO_RUNTIME_KERNEL` / `RUNTIME_TO_ELIZA1_KERNEL`
// below — that is the single source of truth for the manifest↔runtime kernel
// bridge.
export const ELIZA_1_KERNELS = [
	"turboquant_q3",
	"turboquant_q4",
	"qjl",
	"polarquant",
	"dflash",
	"turbo3_tcq",
] as const;
export type Eliza1Kernel = (typeof ELIZA_1_KERNELS)[number];
export type Eliza1RequiredRuntimeKernel = Exclude<
	LocalRuntimeKernel,
	"openvino"
>;

// Manifest-kernel ↔ runtime-kernel bridge.
//
// `Eliza1Kernel` (this module, the bundle-manifest layer) names the *named
// optimization* a bundle advertises; `LocalRuntimeKernel`
// (`@elizaos/shared/local-inference/types`, the llama.cpp-handle layer) names
// the *fork kernel handle* the binary must expose. They overlap but are not the
// same enum:
//
//   turboquant_q3  ↔ turbo3       (Q3 KV-cache quant kernel)
//   turboquant_q4  ↔ turbo4       (Q4 KV-cache quant kernel)
//   qjl            ↔ qjl_full     (QuIP#-JL fused-attention kernel)
//   polarquant     ↔ polarquant   (same name on both layers)
//   dflash         ↔ dflash       (same name on both layers)
//   turbo3_tcq     ↔ turbo3_tcq   (same name on both layers)
//
// Every Eliza-1 custom-kernel member is covered (both are total maps over the
// custom W4-B/DFlash kernel set). `openvino` is a runtime backend capability,
// not an Eliza-1 bundle optimization, so it intentionally stays outside this
// bridge. When code needs to translate between the catalog's custom
// `requiresKernel` entries and the manifest's `kernels.required:
// Eliza1Kernel[]`, route it through these.
export const ELIZA1_TO_RUNTIME_KERNEL: Readonly<
	Record<Eliza1Kernel, Eliza1RequiredRuntimeKernel>
> = {
	turboquant_q3: "turbo3",
	turboquant_q4: "turbo4",
	qjl: "qjl_full",
	polarquant: "polarquant",
	dflash: "dflash",
	turbo3_tcq: "turbo3_tcq",
};

export const RUNTIME_TO_ELIZA1_KERNEL: Readonly<
	Record<Eliza1RequiredRuntimeKernel, Eliza1Kernel>
> = {
	turbo3: "turboquant_q3",
	turbo4: "turboquant_q4",
	qjl_full: "qjl",
	polarquant: "polarquant",
	dflash: "dflash",
	turbo3_tcq: "turbo3_tcq",
};

export const ELIZA_1_BACKENDS = [
	"metal",
	"vulkan",
	"cuda",
	"rocm",
	"cpu",
] as const;
export type Eliza1Backend = (typeof ELIZA_1_BACKENDS)[number];

// Required-kernel set per tier. Mirrors the active Eliza-1 release policy:
// - All tiers require turboquant + qjl + polarquant.
// - 2B and larger tiers require DFlash.
// - All current text GGUFs ship at the 128k half-context floor or the 262k
//   native tier, so every tier requires `turbo3_tcq`. The validator also
//   enforces the same requirement dynamically for any bundle that declares
//   a >64k text file, so a future tier cannot publish long-context text
//   without TCQ.
//
// Q4 is the release text quant baseline. TCQ is required for 4b and above
// because every text tier ships long-context text variants.
export const REQUIRED_KERNELS_BY_TIER: Readonly<
	Record<Eliza1Tier, ReadonlyArray<Eliza1Kernel>>
> = {
	"0_8b": ["turboquant_q4", "qjl", "polarquant", "turbo3_tcq"],
	"2b": ["turboquant_q4", "qjl", "polarquant", "dflash", "turbo3_tcq"],
	"4b": ["turboquant_q4", "qjl", "polarquant", "dflash", "turbo3_tcq"],
	"9b": ["turboquant_q4", "qjl", "polarquant", "dflash", "turbo3_tcq"],
	"27b": ["turboquant_q4", "qjl", "polarquant", "dflash", "turbo3_tcq"],
	"27b-256k": ["turboquant_q4", "qjl", "polarquant", "dflash", "turbo3_tcq"],
};

// Backends each tier is expected to support on shipped hardware.
export const SUPPORTED_BACKENDS_BY_TIER: Readonly<
	Record<Eliza1Tier, ReadonlyArray<Eliza1Backend>>
> = {
	"0_8b": ["metal", "vulkan", "cpu"],
	"2b": ["metal", "vulkan", "cpu"],
	"4b": ["metal", "vulkan", "cuda", "rocm", "cpu"],
	"9b": ["metal", "vulkan", "cuda", "rocm", "cpu"],
	"27b": ["metal", "vulkan", "cuda", "rocm", "cpu"],
	"27b-256k": ["metal", "vulkan", "cuda", "rocm", "cpu"],
};

// ---------------------------------------------------------------------------
// Zod definitions
// ---------------------------------------------------------------------------

const sha256 = z
	.string()
	.regex(/^[a-f0-9]{64}$/, "sha256 must be 64 lowercase hex chars");

const lineageEntry = z.object({
	base: z.string().min(1),
	license: z.string().min(1),
});

export const Eliza1LineageSchema = z.object({
	text: lineageEntry,
	voice: lineageEntry,
	drafter: lineageEntry.optional(),
	// Wave-6 (2026-05-10): manifest now records lineage for every shipped
	// component so license/dataset provenance is auditable per component.
	// All optional — a tier may omit ASR/embedding/vision/vad/wakeword by
	// leaving the corresponding `files.*` slot empty AND the lineage
	// entry undefined. The validator enforces lineage-vs-files consistency.
	asr: lineageEntry.optional(),
	embedding: lineageEntry.optional(),
	imagegen: lineageEntry.optional(),
	vision: lineageEntry.optional(),
	vad: lineageEntry.optional(),
	wakeword: lineageEntry.optional(),
	// Voice Wave 2 (2026-05-14): semantic end-of-turn detector lineage. When
	// `files.turn` ships the bundled `livekit/turn-detector` ONNX (the
	// ≤1.7B-tier `v1.2.2-en` SmolLM2 distill or the ≥4B-tier `v0.4.1-intl`
	// pruned Qwen2.5-0.5B), this records the upstream repo + license. Apache-2.0
	// fallback path is `latishab/turnsense`.
	turn: lineageEntry.optional(),
	// Voice Wave 2 (2026-05-14): acoustic-prosody emotion classifier lineage.
	// When `files.emotion` ships the bundled `wav2small-msp-dim-int8.onnx`
	// (72K params, ~120 KB), this records the audeering teacher repo + license
	// as research-only attribution (the audeering teacher is CC-BY-NC-SA-4.0
	// and NEVER bundled — only the Apache-2.0 student is shipped, distilled
	// via `packages/training/scripts/emotion/distill_wav2small.py`). The
	// SamLowe/roberta-base-go_emotions-onnx text classifier may optionally
	// also ship under this slot when the operator enables the text-classifier
	// shadow path; see R3-emotion.md §2.
	emotion: lineageEntry.optional(),
});

export const Eliza1FileEntrySchema = z.object({
	path: z.string().min(1),
	sha256,
	// text files declare their context length so the runtime can pick the
	// largest variant that fits the device's RAM budget. Other file kinds
	// never have ctx.
	ctx: z.number().int().min(131072).optional(),
});

export const Eliza1FilesSchema = z.object({
	text: z.array(Eliza1FileEntrySchema).min(1),
	voice: z.array(Eliza1FileEntrySchema).min(1),
	asr: z.array(Eliza1FileEntrySchema),
	vision: z.array(Eliza1FileEntrySchema),
	dflash: z.array(Eliza1FileEntrySchema),
	cache: z.array(Eliza1FileEntrySchema).min(1),
	// Wave-6 (2026-05-10): the omni bundle ships a per-bundle dedicated
	// embedding model (Qwen3-Embedding-GGUF on non-lite tiers) and
	// a Silero-VAD ONNX + an optional openWakeWord GGUF (replacing the
	// previous three-file ONNX layout — the combined GGUF carries the
	// mel filterbank + speech embedding model + every per-phrase head).
	// All three are optional in the schema — the 0_8b tier intentionally
	// omits the dedicated embedding (pools from text backbone) and a
	// tier may ship without wake-word support.
	//
	// Schema-level optionality: empty array = "this bundle does not
	// ship this component"; the validator enforces tier-specific
	// consistency rules (e.g. 4b-and-up MUST ship `embedding[]`).
	embedding: z.array(Eliza1FileEntrySchema).optional(),
	// Optional image-generation artifacts. Most Eliza-1 base bundles do not
	// carry diffusion weights; those are documented in
	// docs/ELIZA_1_BUNDLE_EXTRAS.json and downloaded on first use. When a
	// future bundle does ship local image-gen weights inline, list them here
	// and provide matching `lineage.imagegen`.
	imagegen: z.array(Eliza1FileEntrySchema).optional(),
	vad: z.array(Eliza1FileEntrySchema).optional(),
	wakeword: z.array(Eliza1FileEntrySchema).optional(),
	// Voice Wave 2 (2026-05-14): bundled semantic turn detector. Optional —
	// when omitted, the runtime falls back to `HeuristicEotClassifier` (the
	// deterministic punctuation/conjunction baseline). When present, the
	// runtime loads the ONNX via `LiveKitTurnDetector` (or `TurnsenseEotClassifier`
	// for the Apache-2.0 fallback) and pre-warms it at voice-session start.
	// Tier mapping is data-driven (see `stage_turn_detector` in
	// `packages/training/scripts/manifest/stage_eliza1_bundle_assets.py`):
	// 0_8b/2b ship the EN-only SmolLM2-135M distill (~66 MB Q8 ONNX);
	// 4b/9b/27b ship the multilingual pruned Qwen2.5-0.5B (~396 MB Q8 ONNX).
	turn: z.array(Eliza1FileEntrySchema).optional(),
	// Eliza-1 EOT LoRA adapter — optional, complements `turn`. When
	// present, the runtime layers this adapter onto the in-process
	// drafter at voice-session start (`voice/eliza1-eot-scorer.ts`) so
	// P(`<|im_end|>`) calibration matches a fine-tuned EOT head without
	// shipping a second base model. When both `turn` and `eotLoraAdapter`
	// are present the operator picks via `ELIZA_VOICE_EOT_BACKEND` or
	// `startVoiceSession({ useEliza1Eot })`. Training recipe:
	// `packages/training/scripts/turn_detector/configs/turn_detector_eliza1_drafter.yaml`.
	eotLoraAdapter: z.array(Eliza1FileEntrySchema).optional(),
	// Voice Wave 2 (2026-05-14): bundled acoustic-prosody emotion classifier
	// (Wav2Small student, ~120 KB int8 ONNX). Optional — when omitted, the
	// runtime falls back to the lexicon + audio-prosody heuristic path inside
	// `attributeVoiceEmotion()` (no acoustic-model evidence row). When present,
	// the runtime loads the ONNX via `VoiceEmotionClassifier`, runs it on
	// `isFinal` transcript snapshots, and fuses the output with the Stage-1
	// text-emotion field via the single fusion point in `emotion-attribution.ts`.
	// All tiers ship the same Wav2Small student (the on-device budget is
	// dominated by the LM, not this 120 KB head); a 0_8b bundle may still
	// choose to omit it to save the cold-start cost.
	emotion: z.array(Eliza1FileEntrySchema).optional(),
});

export const Eliza1KernelEnumSchema = z.enum(ELIZA_1_KERNELS);
export const Eliza1BackendEnumSchema = z.enum(ELIZA_1_BACKENDS);
export const Eliza1TierEnumSchema = z.enum(ELIZA_1_TIERS);

export const Eliza1VerifiedBackendStatusSchema = z.object({
	status: z.enum(["pass", "fail", "skipped"]),
	atCommit: z.string().min(1),
	report: z.string().min(1),
	// Optional provenance for a "pass" recorded on a single device class — e.g.
	// the runtime Vulkan dispatch smoke that ran on one Intel-ANV GPU. `caveat`
	// names what device coverage is still missing so the recommendation engine
	// and release docs do not over-claim.
	device: z.string().min(1).optional(),
	caveat: z.string().min(1).optional(),
});

// Recipe-level kernel layout pins, folded in from the quantization recipes'
// `kernel_manifest` sidecar fragments
// (packages/training/scripts/quantization/_kernel_manifest.py). Keyed by the
// *recipe* kernel-target name (`turbo3` / `turbo4` / `turbo3_tcq` / `qjl1_256` /
// `polar_q4`) — NOT the manifest-level capability names in `ELIZA_1_KERNELS`.
// The runtime/downloader can verify the encoded blocks match the kernels it
// ships; the publish orchestrator already validates the sidecars exist.
export const Eliza1RecipeKernelPinsSchema = z.object({
	blockLayoutVersion: z.string().min(1),
	codebookHash: z.string().min(1),
	perBlockTolerance: z.number().positive(),
});

export const Eliza1Eagle3KernelSchema = z
	.object({
		enabled: z.boolean().optional(),
		capability: z.string().min(1).optional(),
		specType: z.string().min(1).optional(),
		model: z.string().min(1).optional(),
		maxDraftTokens: z.number().int().positive().optional(),
		failure: z.string().min(1).optional(),
	})
	.passthrough();

export const Eliza1KernelsSchema = z.object({
	required: z.array(Eliza1KernelEnumSchema).min(1),
	optional: z.array(Eliza1KernelEnumSchema),
	verifiedBackends: z.object({
		metal: Eliza1VerifiedBackendStatusSchema,
		vulkan: Eliza1VerifiedBackendStatusSchema,
		cuda: Eliza1VerifiedBackendStatusSchema,
		rocm: Eliza1VerifiedBackendStatusSchema,
		cpu: Eliza1VerifiedBackendStatusSchema,
	}),
	recipeManifest: z.record(z.string(), Eliza1RecipeKernelPinsSchema).optional(),
	// Optional EAGLE3 capability metadata. This is intentionally separate from
	// the DFlash kernel capability and is never added to REQUIRED_KERNELS_BY_TIER.
	eagle3: Eliza1Eagle3KernelSchema.optional(),
});

// Wave-6: voice surface declares which expressive features the bundled
// TTS supports. Today these are tag-driven inline in the input text;
// presence of `singing` or `emotion-tags` here lets the runtime expose
// the relevant API surface and lets the planner emit tags inline.
export const ELIZA_1_VOICE_CAPABILITIES = [
	"tts",
	"emotion-tags",
	"singing",
] as const;
export const ELIZA_1_VOICE_MANIFEST_VERSION = "1";
export const VOICE_PRESET_CACHE_PATH = "cache/voice-preset-default.bin";
export type Eliza1VoiceCapability = (typeof ELIZA_1_VOICE_CAPABILITIES)[number];

export const Eliza1VoiceSchema = z.object({
	version: z.string().min(1),
	frozen: z.literal(true),
	cache: z.object({
		speakerPreset: z.string().min(1),
		phraseCacheSeed: z.string().min(1),
	}),
	capabilities: z.array(z.enum(ELIZA_1_VOICE_CAPABILITIES)).default(["tts"]),
});

const Eliza1Eagle3EvalSchema = z
	.object({
		/** accepted/drafted; null or absent when not measured. */
		acceptanceRate: z.number().min(0).max(1).nullable().optional(),
		/** EAGLE3-on tok/s ÷ baseline tok/s; null or absent when not measured. */
		speedup: z.number().nonnegative().nullable().optional(),
		/** Preferred spelling for pass/fail status. */
		passed: z.boolean().optional(),
		/** Back-compat spelling accepted for manifest producers that emit `pass`. */
		pass: z.boolean().optional(),
		/** Human-readable reason when the EAGLE3 eval was not run or failed. */
		failure: z.string().min(1).optional(),
	})
	.superRefine((eagle3, ctx) => {
		if (
			eagle3.pass !== undefined &&
			eagle3.passed !== undefined &&
			eagle3.pass !== eagle3.passed
		) {
			ctx.addIssue({
				code: "custom",
				message: "pass and passed must agree when both are present",
				path: ["pass"],
			});
		}
		const passed = eagle3.passed ?? eagle3.pass;
		if (
			passed === true &&
			(eagle3.acceptanceRate == null || eagle3.speedup == null)
		) {
			ctx.addIssue({
				code: "custom",
				message: "passed=true requires measured acceptanceRate and speedup",
				path: ["passed"],
			});
		}
	});

export const Eliza1EvalsSchema = z.object({
	textEval: z.object({
		score: z.number().min(0).max(1),
		passed: z.boolean(),
	}),
	voiceRtf: z.object({
		rtf: z.number().nonnegative(),
		passed: z.boolean(),
	}),
	e2eLoopOk: z.boolean(),
	thirtyTurnOk: z.boolean(),
	// Wave-6 additions — all optional so a tier can publish without
	// an ASR / embedding component declared. `expressive` covers the
	// singing/emotion-tag eval gates from `eliza1_gates.yaml`. The
	// validator refuses defaultEligible=true if any declared component's
	// gate is missing OR fails.
	asrWer: z
		.object({
			wer: z.number().nonnegative(),
			passed: z.boolean(),
		})
		.optional(),
	embedMteb: z
		.object({
			score: z.number().min(0).max(1),
			passed: z.boolean(),
		})
		.optional(),
	vadLatencyMs: z
		.object({
			median: z.number().nonnegative(),
			boundaryMs: z.number().nonnegative().optional(),
			endpointMs: z.number().nonnegative().optional(),
			falseBargeInRate: z.number().min(0).max(1).optional(),
			passed: z.boolean(),
		})
		.optional(),
	expressive: z
		.object({
			tagFaithfulness: z.number().min(0).max(1),
			mosExpressive: z.number().nonnegative(),
			tagLeakage: z.number().nonnegative(),
			passed: z.boolean(),
		})
		.optional(),
	// DFlash speculative-decoding bench. Optional — a bundle whose DFlash
	// drafter is still a stand-in records this as `passed: false` with
	// `acceptanceRate: null` / `speedup: null` ("needs hardware / needs a
	// trained drafter" — recorded, not faked, per AGENTS.md §3 / §7). The
	// gate thresholds live in the `dflash:` section of `eliza1_gates.yaml`;
	// the bench numbers come from `dflash_drafter_runtime_smoke.mjs --bench`.
	dflash: z
		.object({
			/** accepted/drafted; null when no hardware/drafter was available. */
			acceptanceRate: z.number().min(0).max(1).nullable(),
			/** drafter-on tok/s ÷ baseline tok/s; null when not measured. */
			speedup: z.number().nonnegative().nullable(),
			passed: z.boolean(),
		})
		.optional(),
	// Optional EAGLE3 speculative-decoding bench metadata. This is independent
	// from DFlash and does not make EAGLE3 required for any tier.
	eagle3: Eliza1Eagle3EvalSchema.optional(),
	// Voice Wave 2 (2026-05-14): semantic end-of-turn detector eval gates.
	// Required when `files.turn` is non-empty (validator enforces). Thresholds
	// applied by `eval_turn_detector.py` in `packages/training/scripts/turn_detector/`:
	//   f1            ≥ TURN_DETECTOR_F1_THRESHOLD           (0.85)
	//   meanLatencyMs ≤ TURN_DETECTOR_MEAN_LATENCY_MS_LIMIT  (30 ms)
	// `passed` is precomputed by the eval script per the constants above so
	// the validator stays a single source of truth; constants are exported
	// from this module for the script + tests to consume.
	turnDetector: z
		.object({
			f1: z.number().min(0).max(1),
			meanLatencyMs: z.number().nonnegative(),
			passed: z.boolean(),
			// Which detector backend the eval was run against. Optional for
			// back-compat with bundles staged before the eliza-1 EOT path;
			// when absent, consumers should assume `livekit`.
			kind: z.enum(["livekit", "turnsense", "eliza-1-drafter"]).optional(),
		})
		.optional(),
	// Voice Wave 2 (2026-05-14): acoustic-emotion classifier eval gates.
	// Required when `files.emotion` is non-empty (validator enforces).
	// Thresholds applied by the bench harness under
	// `packages/benchmarks/voice-emotion/`:
	//   macroF1Meld     ≥ EMOTION_CLASSIFIER_MELD_F1_THRESHOLD     (0.35)
	//   macroF1Iemocap  ≥ EMOTION_CLASSIFIER_IEMOCAP_F1_THRESHOLD  (0.60)
	// The MELD threshold is intentionally low — 7-class conversational SER
	// macro-F1 is 0.40-0.50 even for strong models on MELD; we set the gate so
	// a real improvement does not get refused (R3-emotion §6 risk).
	emotionClassifier: z
		.object({
			macroF1Meld: z.number().min(0).max(1),
			macroF1Iemocap: z.number().min(0).max(1),
			/** Mean per-clip inference latency on CPU. */
			meanLatencyMs: z.number().nonnegative(),
			passed: z.boolean(),
		})
		.optional(),
});

/** Eval-gate threshold: minimum acceptable F1 on the EOU benchmark. */
export const TURN_DETECTOR_F1_THRESHOLD = 0.85 as const;

/** Eval-gate threshold: maximum acceptable mean inference latency (ms). */
export const TURN_DETECTOR_MEAN_LATENCY_MS_LIMIT = 30 as const;

/** Eval-gate threshold: minimum macro-F1 on MELD test (7-class). */
export const EMOTION_CLASSIFIER_MELD_F1_THRESHOLD = 0.35 as const;

/** Eval-gate threshold: minimum macro-F1 on IEMOCAP test (4-class). */
export const EMOTION_CLASSIFIER_IEMOCAP_F1_THRESHOLD = 0.6 as const;

/** Eval-gate threshold: maximum mean CPU inference latency (ms) per window. */
export const EMOTION_CLASSIFIER_MEAN_LATENCY_MS_LIMIT = 30 as const;

export const Eliza1RamBudgetSchema = z
	.object({
		min: z.number().int().positive(),
		recommended: z.number().int().positive(),
	})
	.refine((r) => r.recommended >= r.min, {
		message: "ramBudgetMb.recommended must be >= ramBudgetMb.min",
	});

// Release-state vocabulary. `base-v1` is the v1 product: the upstream BASE
// models — GGUF-converted via the elizaOS/llama.cpp fork and fully
// Eliza-optimized (every quant/kernel trick in inference/AGENTS.md §3) —
// but NOT fine-tuned (fine-tuning ships in v2). `base-v1-candidate` is the
// in-progress state of a base-v1 bundle before every release-blocking
// gate (real fork-built bytes, every supported-backend kernel verify,
// every required platform-dispatch report, the runnable-on-base evals)
// has gone green. It is publishable to HuggingFace as a download target
// and is installable on a device whose backend it verified, but is not
// the strict release — its `defaultEligible` stays `false` at publish
// time. `finetuned-v2` is the v2 state; `local-standin` is a non-publishable
// staging shape; `upload-candidate` / `final` are the historical
// fine-tuned-v1 publish states retained for forward-compat. Mirrors
// `ELIZA_1_RELEASE_STATES` in
// `packages/training/scripts/manifest/eliza1_manifest.py`.
export const ELIZA_1_RELEASE_STATES = [
	"local-standin",
	"base-v1-candidate",
	"base-v1",
	"finetuned-v2",
	"upload-candidate",
	"final",
] as const;
export type Eliza1ReleaseState = (typeof ELIZA_1_RELEASE_STATES)[number];

// Release-channel vocabulary recorded on a published manifest.
// `recommended` is the fine-tuned Eliza-1 (ships in v2) — the channel a
// device may auto-promote to the strict default. `base-v1` is the
// upstream-base + kernel-optimized release: every quant/kernel trick
// applied, but the text weights are the upstream base GGUFs (not the
// fine-tuned Eliza-1). A `base-v1`-channel manifest MUST be
// `defaultEligible: false` at publish time. The on-device gate
// (`canSetAsDefault`) still promotes a contract-valid `base-v1` bundle to
// the fallback default when no `recommended` channel bundle is installed —
// see `validator.ts`. Mirrors `ELIZA_1_RELEASE_CHANNELS` (Python side).
export const ELIZA_1_RELEASE_CHANNELS = ["recommended", "base-v1"] as const;
export type Eliza1ReleaseChannel = (typeof ELIZA_1_RELEASE_CHANNELS)[number];

// Provenance slots — the bundle components whose upstream source repo a
// `base-v1` manifest must record. Mirrors `ELIZA_1_PROVENANCE_SLOTS`
// (Python side).
export const ELIZA_1_PROVENANCE_SLOTS = [
	"text",
	"voice",
	"asr",
	"vad",
	"embedding",
	"imagegen",
	"vision",
	"drafter",
] as const;
export type Eliza1ProvenanceSlot = (typeof ELIZA_1_PROVENANCE_SLOTS)[number];

const eliza1SourceModelEntry = z.object({
	/** Upstream HuggingFace repo this component is converted from. */
	repo: z.string().min(1),
	/** Specific file in the upstream repo, when the source is one file. */
	file: z.string().min(1).optional(),
	/** The converter / recipe path used (e.g. `<fork>/convert_hf_to_gguf.py`). */
	convertedVia: z.string().min(1).optional(),
	/** Free-text provenance note. */
	note: z.string().min(1).optional(),
});

// `provenance` — optional manifest block. Required on a `base-v1` bundle so
// the "base, not fine-tuned" plan is auditable: which upstream repo each
// shipped component is converted from, and whether v1 fine-tuning was
// applied (always `false` for the base-v1 release). The contract validator
// enforces per-component coverage for `base-v1`.
export const Eliza1ProvenanceSchema = z.object({
	releaseState: z.enum(ELIZA_1_RELEASE_STATES),
	finetuned: z.boolean(),
	sourceModels: z.record(
		z.enum(ELIZA_1_PROVENANCE_SLOTS),
		eliza1SourceModelEntry,
	),
});

export const Eliza1ManifestSchema = z
	.object({
		$schema: z.literal(ELIZA_1_MANIFEST_SCHEMA_URL).optional(),
		id: z.string().min(1),
		tier: Eliza1TierEnumSchema,
		version: z
			.string()
			.regex(
				/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/,
				"version must be semver (e.g. 1.0.0)",
			),
		publishedAt: z.string().datetime(),
		lineage: Eliza1LineageSchema,
		files: Eliza1FilesSchema,
		kernels: Eliza1KernelsSchema,
		evals: Eliza1EvalsSchema,
		ramBudgetMb: Eliza1RamBudgetSchema,
		// Wave-6: optional. Default = `{ capabilities: ["tts"] }` (base TTS only,
		// no emotion tags, no singing). Bundles that ship the omnivoice-singing
		// weights advertise `["tts","emotion-tags","singing"]`.
		voice: Eliza1VoiceSchema.optional(),
		// Optional. Present on `base-v1` bundles (the upstream base models,
		// GGUF-converted + fully optimized, NOT fine-tuned). Records the
		// release state, the not-fine-tuned flag, and the upstream source repo
		// per shipped component. The contract validator requires per-component
		// coverage when `releaseState === "base-v1"`.
		provenance: Eliza1ProvenanceSchema.optional(),
		// Optional. Defaults to `"recommended"` semantically when unset (the
		// fine-tuned Eliza-1 — the channel allowed to auto-promote to the
		// strict device default). A `"base-v1"`-channel manifest is the
		// upstream-base + kernel-optimized release; it MUST be
		// `defaultEligible: false` at publish time. The on-device gate
		// (`canSetAsDefault`) still allows a contract-valid `base-v1` bundle
		// to fill an empty default slot when no `recommended` channel bundle
		// is installed; the recommender prefers `defaultEligible: true` over
		// candidates whenever both are available.
		releaseChannel: z.enum(ELIZA_1_RELEASE_CHANNELS).optional(),
		defaultEligible: z.boolean(),
		// Optional. Quant metadata emitted by the publish-side manifest
		// builder. May be either a free-text tag (`"Q3_K_S"`, `"Q4_K_M"`) or a
		// structured object describing the optimization recipe (PolarQuant +
		// QJL block layout, per-layer outlier counts, etc.). Not consumed by
		// the runtime validator — declared here so a manifest carrying it is
		// accepted instead of being stripped or rejected. The schema is
		// intentionally permissive: the publish-side tool is the source of
		// truth for the shape, and the runtime only needs the manifest to
		// round-trip cleanly.
		textQuant: z
			.union([z.string().min(1), z.record(z.string(), z.unknown())])
			.optional(),
	})
	// The id MUST encode the tier so catalogs can derive tier from id without
	// re-reading the manifest. Example: `id: "eliza-1-9b"`.
	.refine(
		(m) =>
			m.id === `eliza-1-${m.tier}` || m.id.startsWith(`eliza-1-${m.tier}-`),
		{
			message: "id must start with `eliza-1-<tier>`",
			path: ["id"],
		},
	)
	// A `base-v1`-channel manifest is the upstream-base release. At publish
	// time it MUST be `defaultEligible: false` — the on-device gate
	// (`canSetAsDefault`) is the one that allows it to fill an empty default
	// slot when no `recommended` bundle is installed. Mirrors
	// inference/AGENTS.md §6 and the Python manifest builder.
	.refine(
		(m) => m.releaseChannel !== "base-v1" || m.defaultEligible === false,
		{
			message: "releaseChannel=base-v1 requires defaultEligible: false",
			path: ["defaultEligible"],
		},
	);
