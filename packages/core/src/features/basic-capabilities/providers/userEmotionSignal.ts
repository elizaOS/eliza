/**
 * USER_EMOTION_SIGNAL — surfaces the fused user-emotion read (voice + text)
 * into the planner prompt as a one-line `USER_SIGNAL: ...` context entry.
 *
 * Per R3-emotion.md §3 ("Downstream consumers" item 1) and the I3 brief:
 * opt-in, additive, never gates action selection — emotion is a hint, not a
 * guard. We only emit the line when the *fused* attribution carries
 * `confidence > 0.6`; below that we stay silent (the planner is sensitive to
 * prompt-cache stability, so the empty-result shape is the same bytes every
 * turn the signal isn't present).
 *
 * Two signal sources:
 *   - voice (acoustic) — written into `Memory.metadata.voice.emotion` by
 *     the local-inference engine bridge on `isFinal` transcript snapshots,
 *   - text (lexical) — the Stage-1 `emotion` field-evaluator value, which
 *     rides on `Content.emotion` (the dynamic property channel).
 *
 * Fusion is done in `attributeVoiceEmotion()` (single fusion point, R3 §3
 * "Two confidence scores, no fusion rule" risk). This provider is read-only
 * — it never re-fuses, it just reports what the bridge already computed.
 *
 * Opt-out via runtime setting `ELIZA_VOICE_EMOTION_INTO_PLANNER` (set to
 * `"0"` to suppress). The opt-in default matches the R3-emotion §3 design:
 * planner sees the hint by default, the user can turn it off.
 */

import type {
	IAgentRuntime,
	Memory,
	Provider,
	State,
} from "../../../types/index.ts";
import { asRecord } from "../../../utils/type-guards.ts";

const EMOTION_LABELS = [
	"happy",
	"sad",
	"angry",
	"nervous",
	"calm",
	"excited",
	"whisper",
] as const;
type EmotionLabel = (typeof EMOTION_LABELS)[number];

/** Threshold below which we stay silent — see R3-emotion §3. */
const CONFIDENCE_THRESHOLD = 0.6;

function isEmotionLabel(value: unknown): value is EmotionLabel {
	return (
		typeof value === "string" &&
		(EMOTION_LABELS as readonly string[]).includes(value)
	);
}

function readVoiceEmotion(
	message: Memory,
): { label: EmotionLabel; confidence: number; method?: string } | null {
	const metadata = asRecord(message.content?.metadata);
	if (!metadata) return null;
	const voice = asRecord(metadata.voice);
	if (!voice) return null;
	const emotion = asRecord(voice.emotion);
	if (!emotion) return null;
	if (!isEmotionLabel(emotion.label)) return null;
	const confidence =
		typeof emotion.confidence === "number" ? emotion.confidence : 0;
	if (!(confidence > CONFIDENCE_THRESHOLD)) return null;
	const method =
		typeof emotion.method === "string" ? emotion.method : undefined;
	return { label: emotion.label, confidence, method };
}

function readTextEmotion(message: Memory): string | null {
	const content = message.content as { emotion?: unknown } | undefined;
	const raw = content?.emotion;
	if (typeof raw !== "string") return null;
	const normalized = raw.trim().toLowerCase();
	if (!normalized || normalized === "none") return null;
	if (!isEmotionLabel(normalized)) return null;
	return normalized;
}

function isOptedOut(runtime: IAgentRuntime): boolean {
	const value = runtime.getSetting?.("ELIZA_VOICE_EMOTION_INTO_PLANNER");
	if (value === undefined || value === null) return false;
	const str = String(value).trim().toLowerCase();
	return str === "0" || str === "false" || str === "off" || str === "no";
}

export const userEmotionSignalProvider: Provider = {
	name: "USER_EMOTION_SIGNAL",
	description:
		"User-side emotion read (voice + text). Hint only — never gates action selection.",
	position: -5,
	contexts: ["general"],
	contextGate: { anyOf: ["general"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "USER" },

	get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
		if (isOptedOut(runtime)) {
			return { text: "", values: {}, data: {} };
		}
		const voice = readVoiceEmotion(message);
		const text = readTextEmotion(message);
		if (!voice && !text) {
			return { text: "", values: {}, data: {} };
		}
		const segments: string[] = [];
		if (voice) {
			segments.push(
				`voice emotion = ${voice.label} (conf ${voice.confidence.toFixed(2)})`,
			);
		}
		if (text) {
			segments.push(`text emotion = ${text}`);
		}
		const line = `USER_SIGNAL: ${segments.join("; ")}`;
		return {
			text: line,
			values: {
				userEmotionVoiceLabel: voice?.label ?? "",
				userEmotionVoiceConfidence: voice?.confidence ?? 0,
				userEmotionVoiceMethod: voice?.method ?? "",
				userEmotionTextLabel: text ?? "",
			},
			data: {
				voice: voice ?? null,
				text: text ?? null,
			},
		};
	},
};
