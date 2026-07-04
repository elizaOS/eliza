/**
 * HTTP route for a native-captured voice turn — `POST /api/voice/native-pcm-turn`.
 *
 * Decodes a base64 Float32 mono PCM buffer plus its sample rate, then hands the
 * turn to `localInferenceEngine.runVoiceTurn` (after staging the active bundle's
 * ASR model) so a mobile WebView that captured audio natively can drive the full
 * on-device voice pipeline. Turn lifecycle events are logged; engine failure
 * surfaces as a 503.
 */

import type http from "node:http";
import { logger, readJsonBody, sendJson, sendJsonError } from "@elizaos/core";
import { localInferenceEngine } from "../services/engine";
import type { VoicePipelineEvents } from "../services/voice/pipeline";

const ROUTE_PATH = "/api/voice/native-pcm-turn";
const MAX_PCM_BYTES = 20 * 1024 * 1024;
const DEFAULT_SAMPLE_RATE = 16_000;

type NativePcmTurnBody = {
	turnId?: unknown;
	pcm?: unknown;
	sampleRate?: unknown;
	signal?: unknown;
};

function decodeFloat32Base64(value: unknown): Float32Array | string {
	if (typeof value !== "string" || value.length === 0) {
		return "pcm must be a non-empty base64 string";
	}
	const bytes = Buffer.from(value, "base64");
	if (bytes.byteLength === 0 || bytes.byteLength > MAX_PCM_BYTES) {
		return `pcm byte length must be between 1 and ${MAX_PCM_BYTES}`;
	}
	if (bytes.byteLength % 4 !== 0) {
		return "pcm byte length must be a multiple of 4 for Float32 PCM";
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const pcm = new Float32Array(bytes.byteLength / 4);
	for (let i = 0; i < pcm.length; i += 1) {
		pcm[i] = view.getFloat32(i * 4, true);
	}
	return pcm;
}

function normalizeSampleRate(value: unknown): number | string {
	if (value === undefined) return DEFAULT_SAMPLE_RATE;
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		!Number.isInteger(value) ||
		value <= 0 ||
		value > 192_000
	) {
		return "sampleRate must be an integer between 1 and 192000";
	}
	return value;
}

function normalizeTurnId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function voiceEventsForTurn(args: {
	turnId?: string;
	nativeSignal?: unknown;
}): VoicePipelineEvents {
	return {
		onComplete(exitReason) {
			logger.info(
				{
					turnId: args.turnId,
					exitReason,
					nativeSignal: args.nativeSignal,
				},
				"[native-pcm-turn] completed native PCM voice turn",
			);
		},
	};
}

export async function handleNativePcmTurnRoute(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<boolean> {
	const method = (req.method ?? "GET").toUpperCase();
	const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
	if (method !== "POST" || pathname !== ROUTE_PATH) return false;

	const body = await readJsonBody<NativePcmTurnBody>(req, res, {
		maxBytes: MAX_PCM_BYTES + 4096,
	});
	if (!body) return true;

	const pcm = decodeFloat32Base64(body.pcm);
	if (typeof pcm === "string") {
		sendJsonError(res, pcm, 400);
		return true;
	}
	const sampleRate = normalizeSampleRate(body.sampleRate);
	if (typeof sampleRate === "string") {
		sendJsonError(res, sampleRate, 400);
		return true;
	}
	const turnId = normalizeTurnId(body.turnId);

	try {
		await localInferenceEngine.ensureActiveBundleAsrReady();
		const exitReason = await localInferenceEngine.runVoiceTurn(
			{ pcm, sampleRate },
			{ events: voiceEventsForTurn({ turnId, nativeSignal: body.signal }) },
		);
		sendJson(res, { ok: true, turnId: turnId ?? null, exitReason });
	} catch (error) {
		logger.warn(
			{
				turnId,
				error: error instanceof Error ? error.message : String(error),
			},
			"[native-pcm-turn] failed to run native PCM voice turn",
		);
		sendJsonError(
			res,
			error instanceof Error ? error.message : "native PCM voice turn failed",
			503,
		);
	}
	return true;
}
