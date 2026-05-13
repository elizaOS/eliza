// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * LLM-driven reply phrasing — make Eliza speak, not preset templates.
 *
 * The Action handlers in `runtime/actions/*.ts` return two things:
 *   1. **Structured data** — the FACTS Eliza needs to communicate
 *      (e.g., 3 visible wifi networks, the user's battery at 78%, the
 *      app that was just built at `~/.eliza/apps/calendar/`).
 *   2. **Suggested text** — a warm preset string in case the LLM is
 *      unavailable or too slow (the 1B Llama on a fresh-boot USB takes
 *      5–15s for a complete sentence).
 *
 * `rephraseAsEliza()` here takes that pair, the user's exact message,
 * and the live `runtime.useModel(TEXT_LARGE)`, and asks the model:
 * "here's what I want to communicate, here's how the user just asked
 *  — phrase the answer in Eliza's voice." The model produces a fresh
 * reply that uses the user's calibration data + the action's facts +
 * Eliza's character. When the model returns nothing useful in time,
 * we fall back to the suggested text — so the user is never stuck.
 *
 * Default-on once Claude is signed in (the LOGIN_CLAUDE token marker
 * exists at `~/.eliza/auth/claude.json`). Off when only the 1B is
 * available, to keep first-boot latency snappy — but the user can
 * force it on with `USBELIZA_LLM_REPLIES=1`.
 *
 * This is what closes the "slop" gap: the same Action surface, but
 * every visible turn comes from the model rather than a template.
 */

import { ModelType, type IAgentRuntime } from "@elizaos/core";

import { isSignedIn } from "./auth/state.ts";
import type { CalibrationBlock } from "../persona.ts";
import { buildSystemPrompt } from "../persona.ts";

const REPHRASE_TIMEOUT_MS = 8000;
const REPHRASE_MAX_TOKENS = 220;

/**
 * Decide whether to route Action replies through the LLM rather than
 * returning the preset string. Default on when claude or codex is
 * signed in (a real cloud model is available, so latency is fine).
 * Forced on with `USBELIZA_LLM_REPLIES=1`, off with `=0`.
 */
export function llmRepliesEnabled(): boolean {
    const env = process.env.USBELIZA_LLM_REPLIES;
    if (env === "1" || env === "true") return true;
    if (env === "0" || env === "false") return false;
    // Default: on when we have a fast cloud model signed in
    return isSignedIn("claude") || isSignedIn("codex");
}

export interface ActionContext {
    /** Action that just fired (e.g., "HELP", "LIST_APPS", "SETUP_PERSISTENCE"). */
    actionName: string;
    /** The user's exact message that selected this action. */
    userMessage: string;
    /** The factual data the action wants to communicate. JSON-stringify-safe. */
    data: unknown;
    /** Preset fallback prose, returned verbatim when the model is slow or fails. */
    suggestedText: string;
    /** User's calibration block — name, work focus, style preferences. */
    calibration: CalibrationBlock | null;
}

/**
 * Ask the model to rephrase the action's response in Eliza's voice.
 * Returns the model's text on success, or `suggestedText` on timeout /
 * model error / empty reply. Never throws.
 */
export async function rephraseAsEliza(
    runtime: IAgentRuntime,
    ctx: ActionContext,
): Promise<string> {
    if (!llmRepliesEnabled()) {
        return ctx.suggestedText;
    }
    const prompt = buildRephrasePrompt(ctx);
    try {
        const reply = await raceWithTimeout(
            runtime.useModel(ModelType.TEXT_LARGE, {
                prompt,
                stopSequences: [],
                maxTokens: REPHRASE_MAX_TOKENS,
                temperature: 0.6,
            }),
            REPHRASE_TIMEOUT_MS,
        );
        if (typeof reply !== "string") return ctx.suggestedText;
        const trimmed = reply.trim();
        if (trimmed.length === 0) return ctx.suggestedText;
        return trimmed;
    } catch {
        return ctx.suggestedText;
    }
}

/**
 * Compose the prompt sent to `useModel(TEXT_LARGE)`. The shape mirrors
 * the @elizaos/core proto: system prompt + user prompt concatenated
 * (proto has no separate `system` field). The system block carries
 * the full Eliza character + calibration + the action context the
 * model needs to render a faithful reply.
 */
function buildRephrasePrompt(ctx: ActionContext): string {
    const systemPrompt = buildSystemPrompt(ctx.calibration);
    const contextBlock = [
        `Action: ${ctx.actionName}`,
        `User said: ${JSON.stringify(ctx.userMessage)}`,
        `What you need to communicate (structured):`,
        JSON.stringify(ctx.data, null, 2),
        `Preset draft (use it if you can't phrase something better):`,
        ctx.suggestedText,
        ``,
        `Now reply in your voice. One or two sentences of warm prose. No`,
        `markdown formatting. No bullet lists. Do not narrate that you ran`,
        `an action — just say what's true. Use the user's name if it's in`,
        `the calibration block above. Keep it under 300 characters.`,
    ].join("\n");
    return `${systemPrompt}\n\n${contextBlock}`;
}

async function raceWithTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    });
    try {
        return await Promise.race([p, timeout]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}
