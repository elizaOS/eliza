// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * Chat handler — thin HTTP↔runtime adapter.
 *
 * Every turn flows through `runtime/dispatch.ts`, which uses real
 * @elizaos/core AgentRuntime + Action + Plugin + useModel — the same shape
 * milady runs.
 *
 * Onboarding policy: the agent is the single source of truth. On every
 * /api/chat call, `handleOnboarding()` runs FIRST — if calibration.toml
 * doesn't exist yet, it advances the state machine and returns the next
 * question. The elizad Tauri UI is a thin chat surface; it sends an empty
 * trigger message on first window-open and just renders every reply.
 * Calibration writes ONLY happen here (in `commitCalibration`); the UI
 * never touches `~/.eliza/calibration.toml`.
 *
 * Until v10 the agent's onboarding was env-gated behind
 * `USBELIZA_SERVER_ONBOARDING=1` because elizad-side JS also ran its own
 * 5-question CALIBRATION_QUESTIONS array. That duplicated state was slop —
 * we removed the JS-side flow and the gate together so there's one
 * deterministic path.
 */

import { handleOnboarding } from "./onboarding/dispatcher.ts";
import { type CalibrationBlock } from "./persona.ts";
import { dispatch, type ChatLaunch } from "./runtime/dispatch.ts";

export interface ChatRequest {
    message: string;
    /** Optional calibration block from `~/.eliza/calibration.toml`, baked into the system prompt. */
    calibration?: CalibrationBlock | null;
}

export type { ChatLaunch };

export interface ChatResponse {
    schema_version: 1;
    reply: string;
    /** When set, the shell should `invoke('launch_app', { slug })`. */
    launch?: ChatLaunch;
}

export async function chat(request: ChatRequest): Promise<ChatResponse> {
    // Onboarding-first. The agent owns the state machine. An empty message
    // is the "first chat-box open" trigger from elizad — agent answers with
    // the greeting + question 1. Subsequent turns advance through the 10
    // questions until calibration.toml is written; after that this returns
    // null and we fall through to the runtime dispatcher.
    const firstTurn = request.message.trim() === "";
    const onboarding = await handleOnboarding(request.message, firstTurn);
    if (onboarding !== null) {
        return { schema_version: 1, reply: onboarding.reply };
    }

    const result = await dispatch({
        text: request.message,
        calibration: request.calibration ?? null,
    });

    const response: ChatResponse = { schema_version: 1, reply: result.reply };
    if (result.launch !== null) {
        response.launch = result.launch;
    }
    return response;
}
