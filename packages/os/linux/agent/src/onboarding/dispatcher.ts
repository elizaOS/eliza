// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * Onboarding dispatcher — the chat-side state-machine driver.
 *
 * Called from `chat.ts` on every /api/chat request *before* normal
 * intent dispatch. If onboarding is incomplete, this function reads
 * the persisted state, advances it by one question, writes the new
 * state, and returns the reply the agent should send. Once the final
 * question is answered, it writes calibration.toml and returns the
 * closing message + a flag the caller uses to log "onboarding done".
 *
 * Behavior contract:
 *   - First-ever turn (no state, no message contextually useful):
 *     respond with the greeting (question 1).
 *   - Any subsequent turn: try to parse the user's reply with the
 *     current question's `parse`. If parsing succeeds, advance.
 *     Otherwise re-ask with the question's `clarify`. After 2 failed
 *     clarifications on the same question, accept the freeform answer
 *     as-is so the user is never trapped.
 *   - "skip" or "skip this" as a reply: synthesizes a sensible default
 *     (`unknown`/`flexible`/etc) and advances.
 */

import {
    ONBOARDING_GREETING,
    QUESTIONS,
    completionMessage,
    type OnboardingQuestion,
} from "./questions.ts";
import {
    type OnboardingState,
    commitCalibration,
    isOnboardingActive,
    loadState,
    saveState,
} from "./state.ts";
import type { CalibrationBlock } from "../persona.ts";
import { llmRepliesEnabled } from "../runtime/dispatch-llm.ts";

export interface OnboardingTurn {
    /** The reply the chat handler should send back to the user. */
    readonly reply: string;
    /** True iff this turn completed onboarding (calibration.toml just written). */
    readonly completed: boolean;
}

/**
 * Returns `null` when onboarding is finished and the caller should fall
 * through to normal intent dispatch. Otherwise returns the reply +
 * persists state.
 *
 * `firstTurn` distinguishes "user just opened the chat box, send the
 * greeting" from "user typed something, advance the script". When
 * `firstTurn=true` and the persisted state has nextQuestionIndex=0, we
 * emit the greeting without consuming the message.
 */
export async function handleOnboarding(
    message: string,
    firstTurn: boolean,
): Promise<OnboardingTurn | null> {
    if (!isOnboardingActive()) return null;

    const state = loadState();
    if (state === null) return null; // calibration appeared between load checks

    if (state.nextQuestionIndex >= QUESTIONS.length) {
        // Defensive: state file says we're past the last question but
        // calibration.toml is missing. Re-run the final commit so we
        // converge to "done."
        const finalAnswers = state.answers as CalibrationBlock;
        commitCalibration(finalAnswers);
        const completion = completionMessage(state.answers);
        return {
            reply: await rephraseOnboardingTurn(
                completion,
                "COMPLETE",
                state,
                message,
            ),
            completed: true,
        };
    }

    const q = QUESTIONS[state.nextQuestionIndex];
    if (q === undefined) {
        return null;
    }

    if (firstTurn && state.nextQuestionIndex === 0 && Object.keys(state.answers).length === 0) {
        // First-ever interaction — emit the greeting, don't try to
        // parse `message` (which the shell sends as an empty trigger).
        return {
            reply: await rephraseOnboardingTurn(
                ONBOARDING_GREETING,
                String(q.id),
                state,
                "",
            ),
            completed: false,
        };
    }

    const trimmed = message.trim();
    if (trimmed === "") {
        return {
            reply: await rephraseOnboardingTurn(
                q.prompt,
                String(q.id),
                state,
                "",
            ),
            completed: false,
        };
    }

    // "skip" → accept a sensible default and move on.
    if (/^skip(\s|$)/i.test(trimmed) || trimmed.toLowerCase() === "skip this") {
        const next = advance(state, q, defaultForSkip(q.id));
        saveState(next);
        return await emitNext(next, trimmed);
    }

    const parsed = q.parse(trimmed);
    if (parsed !== undefined) {
        const next = advance(state, q, parsed);
        saveState(next);

        // Side effect on the claude offer (question 2): if the user
        // said yes, hand control to the multi-turn claude-flow which
        // opens chromium + asks them to paste the auth code back in
        // chat. The flow's prompt REPLACES the next onboarding question
        // (vs prefixing). When the flow completes (success or bail),
        // onboarding resumes from where we left off — the buildIntent
        // question fires on the user's next message that isn't the
        // code paste.
        if (q.id === "claudeOfferAccepted" && parsed === true && process.env.USBELIZA_STATE_DIR === undefined) {
            try {
                const { beginClaudeFlow } = await import("../runtime/flows/claude-flow.ts");
                const result = await beginClaudeFlow();
                if (!result.done) {
                    // Flow is in-progress; user's next message goes to
                    // continueClaudeFlow via dispatch.ts. After it
                    // completes, the user's next message AGAIN routes
                    // here (onboarding is incomplete) and we ask the
                    // buildIntent question.
                    return { reply: result.reply, completed: false };
                }
                // Flow short-circuited (already-signed-in, no binary,
                // no URL). Continue with buildIntent + prepend the
                // flow's message so the user knows the outcome.
                const turn = await emitNext(next, trimmed);
                return { ...turn, reply: `${result.reply} ${turn.reply}` };
            } catch {
                // Don't gate onboarding on claude-flow setup failures.
                // Just continue.
            }
        }

        // Side effect on the build-intent (question 3): the answer IS
        // the build brief. Fire BUILD_APP via the action surface so the
        // first app starts generating immediately after onboarding.
        // Skip when the user said "nothing" / "skip" / "later".
        if (q.id === "buildIntent" && typeof parsed === "string" && process.env.USBELIZA_STATE_DIR === undefined) {
            const norm = (parsed as string).toLowerCase().trim();
            const skip = /^(nothing|skip|later|nah|no|none|nope|not now)$/.test(norm);
            if (!skip) {
                // Fire BUILD_APP async — codegen takes 30-60s so we
                // return the completion message first; the agent will
                // emit a follow-up turn when the app is ready (via the
                // BUILD_APP action's own reply on subsequent /api/chat).
                void maybeFireBuildApp(parsed as string);
            }
        }

        const turn = await emitNext(next, trimmed);
        return turn;
    }

    // Clarify, but after 2 failed attempts accept the raw answer as
    // freeform — the user shouldn't be trapped in a re-ask loop.
    const attempts = (state.clarifyAttempts[q.id] ?? 0) + 1;
    if (attempts >= 3) {
        const fallback = freeformAccept(q.id, trimmed);
        const next = advance(state, q, fallback);
        saveState(next);
        return await emitNext(next, trimmed);
    }
    const nextState: OnboardingState = {
        schema_version: 1,
        answers: state.answers,
        nextQuestionIndex: state.nextQuestionIndex,
        clarifyAttempts: { ...state.clarifyAttempts, [q.id]: attempts },
    };
    saveState(nextState);
    const clarifyText = q.clarify ?? q.prompt;
    return {
        reply: await rephraseOnboardingTurn(
            clarifyText,
            `${String(q.id)}_CLARIFY`,
            nextState,
            trimmed,
        ),
        completed: false,
    };
}

function advance(
    state: OnboardingState,
    q: OnboardingQuestion,
    value: CalibrationBlock[OnboardingQuestion["id"]],
): OnboardingState {
    const answers: Partial<CalibrationBlock> = { ...state.answers };
    (answers as Record<string, unknown>)[q.id] = value;
    return {
        schema_version: 1,
        answers,
        nextQuestionIndex: state.nextQuestionIndex + 1,
        clarifyAttempts: state.clarifyAttempts,
    };
}

async function emitNext(
    state: OnboardingState,
    lastUserInput: string,
): Promise<OnboardingTurn> {
    if (state.nextQuestionIndex >= QUESTIONS.length) {
        commitCalibration(state.answers as CalibrationBlock);
        const completion = completionMessage(state.answers);
        return {
            reply: await rephraseOnboardingTurn(
                completion,
                "COMPLETE",
                state,
                lastUserInput,
            ),
            completed: true,
        };
    }
    const nextQ = QUESTIONS[state.nextQuestionIndex];
    if (nextQ === undefined) return { reply: "", completed: false };
    return {
        reply: await rephraseOnboardingTurn(
            nextQ.prompt,
            String(nextQ.id),
            state,
            lastUserInput,
        ),
        completed: false,
    };
}

/**
 * Optionally rephrase an onboarding turn through `rephraseAsEliza`.
 *
 * Default is ON for any boot — `useModel(TEXT_LARGE)` always returns a
 * real model reply because `claude-cloud-plugin` delegates to local-llama
 * on no-auth (the 1B Llama on the stick). Onboarding therefore sounds
 * like Eliza speaking from the first turn, even before the user signs
 * in to Claude.
 *
 * Returns the original preset `reply` verbatim only when:
 *   - `USBELIZA_STATE_DIR` is set (tests pin verbatim presets), or
 *   - `USBELIZA_LLM_ONBOARDING=0` explicitly disables it (smoke tests).
 *
 * On any failure (no runtime, timeout, model error), returns the original
 * `reply` — onboarding is never gated on the LLM. Never throws.
 *
 * `questionId` is folded into the action name (e.g. `ONBOARDING_name`,
 * `ONBOARDING_COMPLETE`, `ONBOARDING_name_CLARIFY`) so the rephrase
 * prompt has enough context to keep the question's intent.
 */
async function rephraseOnboardingTurn(
    reply: string,
    questionId: string,
    state: OnboardingState,
    lastUserInput: string,
): Promise<string> {
    // Hard kill switch — explicit `=0` disables onboarding rephrase even
    // when claude is signed in. Useful for deterministic smoke runs.
    if (process.env.USBELIZA_LLM_ONBOARDING === "0") return reply;
    // Test override — `USBELIZA_STATE_DIR` is the codebase's test-mode
    // sentinel; bypass LLM rephrase so the dispatcher.test.ts assertions
    // (which match preset prose verbatim) keep passing.
    if (process.env.USBELIZA_STATE_DIR !== undefined) return reply;
    // No further gate. claude-cloud-plugin delegates to local-llama when
    // not signed in, so useModel(TEXT_LARGE) always works. Onboarding
    // questions get a real model voice from turn 1.
    void llmRepliesEnabled; // referenced for the import; gate removed.
    try {
        const [{ getRuntime }, { rephraseAsEliza }] = await Promise.all([
            import("../runtime/eliza.ts"),
            import("../runtime/dispatch-llm.ts"),
        ]);
        const runtime = await getRuntime();
        const phrased = await rephraseAsEliza(runtime, {
            actionName: `ONBOARDING_${questionId}`,
            userMessage: lastUserInput,
            data: { intent: reply, answersSoFar: state.answers },
            suggestedText: reply,
            // The rephrase context accepts a full CalibrationBlock or null;
            // during onboarding we only have a partial. Cast through unknown
            // — buildSystemPrompt's formatter reads each field defensively
            // and renders only the ones that are present, so a partial is
            // safe at the formatter boundary even though it doesn't satisfy
            // the static shape.
            calibration: (state.answers as unknown) as CalibrationBlock,
        });
        if (typeof phrased !== "string" || phrased.trim().length === 0) {
            return reply;
        }
        return phrased;
    } catch {
        return reply;
    }
}

function defaultForSkip(id: keyof CalibrationBlock): CalibrationBlock[OnboardingQuestion["id"]] {
    switch (id) {
        case "name":
            return "friend";
        case "claudeOfferAccepted":
            return false;
        case "buildIntent":
            // Skip = "nothing yet" = onboarding completes without
            // firing a build. The string is short on purpose so it's
            // obvious in calibration.toml that the user opted out.
            return "skip";
        default:
            throw new Error(`defaultForSkip: unknown question id ${String(id)}`);
    }
}

/**
 * Fire BUILD_APP for the user's onboarding answer to "what do you want
 * me to build first?". Async fire-and-forget — codegen takes 30-60s and
 * we want the onboarding completion message to land immediately. The
 * built app shows up in `~/.eliza/apps/<slug>/` and the user can
 * launch it with "open <thing>" when ready.
 *
 * Soft-fails on every error (no runtime, no claude binary, codegen
 * crash) so onboarding never gets stuck waiting for a build.
 */
function maybeFireBuildApp(brief: string): void {
    if (process.env.USBELIZA_STATE_DIR !== undefined) return;
    void (async () => {
        try {
            const [{ getRuntime }, { BUILD_APP_ACTION }] = await Promise.all([
                import("../runtime/eliza.ts"),
                import("../runtime/actions/build-app.ts"),
            ]);
            const runtime = await getRuntime();
            const { stringToUuid } = await import("@elizaos/core");
            const memory = {
                id: stringToUuid(`onboarding-build-${Date.now()}`),
                entityId: stringToUuid("usbeliza-user"),
                agentId: runtime.agentId,
                roomId: stringToUuid("usbeliza-onboarding"),
                content: { text: `build me ${brief}`, source: "onboarding" },
                createdAt: Date.now(),
            };
            await BUILD_APP_ACTION.handler(runtime, memory, undefined, undefined, async () => []);
        } catch {
            // Fire-and-forget; failed builds surface in `~/.eliza/apps`
            // only when they succeed, which is the natural feedback path.
        }
    })();
}

function freeformAccept(
    id: keyof CalibrationBlock,
    raw: string,
): CalibrationBlock[OnboardingQuestion["id"]] {
    if (id === "name" || id === "buildIntent") {
        return raw.slice(0, 256);
    }
    return defaultForSkip(id);
}
