import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	assertFailClosedReport,
	deriveNativeEmotionStatus,
	deriveReferenceVoiceProfileProductStatus,
	detectAsrNativeEmotionEvidence,
	inspectVoicePresetDefault,
} from "./voice_profile_emotion_status.mjs";

function writePlaceholderPreset(path) {
	const bytes = Buffer.alloc(1052);
	bytes.writeUInt32LE(0x315a4c45, 0);
	bytes.writeUInt32LE(1, 4);
	bytes.writeUInt32LE(24, 8);
	bytes.writeUInt32LE(1024, 12);
	bytes.writeUInt32LE(1048, 16);
	bytes.writeUInt32LE(4, 20);
	writeFileSync(path, bytes);
}

test("detects the narrow Samantha zero-filled placeholder preset", () => {
	const dir = mkdtempSync(join(tmpdir(), "voice-profile-status-"));
	try {
		const preset = join(dir, "voice-preset-default.bin");
		writePlaceholderPreset(preset);
		const result = inspectVoicePresetDefault(preset);
		assert.equal(result.status, "placeholder");
		assert.equal(result.placeholderDetected, true);
		assert.equal(result.referenceCloneSeeded, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("reference voice profile is attribution-only unless native clone round trip passes", () => {
	assert.equal(
		deriveReferenceVoiceProfileProductStatus({
			profileStatus: "ready",
			nativeReferenceClonePass: false,
		}),
		"attribution_ready_synthesis_not_ready",
	);
	assert.equal(
		deriveReferenceVoiceProfileProductStatus({
			profileStatus: "ready",
			nativeReferenceClonePass: true,
		}),
		"ready",
	);
});

test("ASR emotion evidence must explicitly advertise a supported native payload", () => {
	assert.deepEqual(
		detectAsrNativeEmotionEvidence({
			emotionLabel: "happy",
		}),
		{
			status: "absent",
			emotionLabelSupported: false,
			emotionLabels: ["happy"],
			hasVadPayload: false,
			modelNativeEmotionClaimed: false,
		},
	);
	assert.equal(
		detectAsrNativeEmotionEvidence({
			emotionLabel: "happy",
			emotionLabelSupported: true,
		}).modelNativeEmotionClaimed,
		true,
	);
});

test("native emotion status is blocked without both model artifact and ASR payload", () => {
	assert.equal(
		deriveNativeEmotionStatus({
			nativeEmotionModelPresent: false,
			asrEmotionEvidence: { modelNativeEmotionClaimed: true },
		}),
		"not_implemented",
	);
	assert.equal(
		deriveNativeEmotionStatus({
			nativeEmotionModelPresent: true,
			asrEmotionEvidence: { modelNativeEmotionClaimed: true },
		}),
		"implemented",
	);
});

test("fail-closed assertions reject unsupported readiness claims", () => {
	assert.throws(
		() =>
			assertFailClosedReport({
				defaultStreamingTtsRoundTrip: {
					productReady: true,
					tts: { status: "pass" },
					asr: { status: "fail" },
				},
				referenceVoiceProfileProbe: {
					status: "attribution_ready_synthesis_not_ready",
				},
				emotionAwareAsrAssessment: {
					asrNativeEmotion: {
						status: "not_implemented",
						modelNativeEmotionClaimed: false,
					},
				},
			}),
		/default voice productReady=true/,
	);
	assert.throws(
		() =>
			assertFailClosedReport({
				defaultStreamingTtsRoundTrip: { productReady: false },
				referenceVoiceProfileProbe: {
					status: "ready",
					nativeReferenceCloneRoundTrip: {
						status: "fail",
						nativeBlockers: [{ key: "referenceCloneEncodeAbi" }],
					},
				},
				emotionAwareAsrAssessment: {
					asrNativeEmotion: {
						status: "not_implemented",
						modelNativeEmotionClaimed: false,
					},
				},
			}),
		/reference voice profile marked ready/,
	);
});
