import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	assertFailClosedReport,
	deriveNativeEmotionStatus,
	deriveReferenceVoiceProfileProductStatus,
	detectAsrNativeEmotionEvidence,
	inspectBundleAssets,
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

test("bundle asset inspection accepts the canonical Silero GGUF VAD artifact", () => {
	const dir = mkdtempSync(join(tmpdir(), "voice-profile-status-"));
	try {
		mkdirSync(join(dir, "vad"), { recursive: true });
		writeFileSync(join(dir, "vad", "silero-vad-v5.gguf"), "vad");
		writeFileSync(
			join(dir, "eliza-1.manifest.json"),
			`${JSON.stringify({
				files: {
					vad: [
						{
							path: "vad/silero-vad-v5.gguf",
							sha256:
								"d348cd6d87ea53dcd3e6680698c88be326082e27dae899adef653d090bee4995",
						},
					],
				},
			})}\n`,
		);
		const result = inspectBundleAssets({
			bundleRoot: dir,
			tier: "0_8b",
			runtimePath: join(dir, "lib", "libelizainference.dylib"),
		});
		const vad = result.requirements.find((req) => req.key === "sileroVad");
		assert.equal(vad?.status, "present");
		assert.deepEqual(vad?.found, ["vad/silero-vad-v5.gguf"]);
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
