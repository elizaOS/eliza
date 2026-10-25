/**
 * HTTP route for semantic end-of-turn scoring —
 * `POST /api/asr/local-inference/end-of-turn`.
 *
 * A renderer that runs its own capture and silence timing posts the partial
 * ASR transcript here after a short pause. The engine scores it with the
 * fused EOT scorer of the active voice bridge (one causal forward pass over
 * the loaded text model, no extra weights). The route never starts voice or
 * loads a model. When no score can be computed it answers 200 with
 * `{ available: false, reason }` (see `EndOfTurnEvaluation`), so the caller
 * keeps its own silence timeout and never receives a synthetic "complete".
 * `ffi-context-unloaded` means a voice bridge exists without a loaded fused
 * text context (Kokoro-only voice or an unloaded text model).
 *
 * A transcript over `END_OF_TURN_MAX_TRANSCRIPT_CHARS` is refused with 400
 * rather than truncated: an end-of-turn read is for one partial utterance.
 */

import type http from "node:http";
import { localInferenceEngine } from "../services/engine";
import {
	type CompatRuntimeState,
	ensureRouteAuthorized,
	readCompatJsonBody,
	sendJson,
} from "./compat-helpers";

export const END_OF_TURN_PATH = "/api/asr/local-inference/end-of-turn";
export const END_OF_TURN_MAX_TRANSCRIPT_CHARS = 4_096;

export async function handleLocalInferenceEotRoute(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	state: CompatRuntimeState,
): Promise<boolean> {
	const method = req.method?.toUpperCase() ?? "GET";
	const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
	if (method !== "POST" || pathname !== END_OF_TURN_PATH) return false;
	if (!(await ensureRouteAuthorized(req, res, state))) return true;

	const body = await readCompatJsonBody(req, res);
	if (!body) return true;
	const transcript =
		typeof body.transcript === "string" ? body.transcript.trim() : "";
	if (!transcript) {
		sendJson(res, 400, { error: "transcript must be a non-empty string" });
		return true;
	}
	if (transcript.length > END_OF_TURN_MAX_TRANSCRIPT_CHARS) {
		sendJson(res, 400, {
			error: `transcript must be at most ${END_OF_TURN_MAX_TRANSCRIPT_CHARS} characters`,
		});
		return true;
	}

	try {
		sendJson(
			res,
			200,
			await localInferenceEngine.evaluateEndOfTurn(transcript),
		);
	} catch (err) {
		sendJson(res, 502, {
			error: `Local end-of-turn scoring error: ${
				err instanceof Error ? err.message : String(err)
			}`,
		});
	}
	return true;
}
