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
import { suggestTimezoneFromIp } from "./apply-system.ts";
import { isNmcliAvailable, networkStatus } from "../network.ts";
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
        const preset = await promptFor(q);
        return {
            reply: await rephraseOnboardingTurn(
                preset,
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
        // Side effects on the wifi/claude offers (questions 2 + 3): when
        // the user says yes, kick off the appropriate flow / OAuth in
        // the background before emitting the next onboarding question.
        // The dispatcher in `runtime/dispatch.ts` checks flow state first,
        // so a yes-to-wifi will route the user's next message into the
        // multi-turn wifi flow handler. The claude offer fires the
        // LOGIN_CLAUDE action async (fire-and-forget) and lets onboarding
        // continue — the OAuth window opens in chromium in parallel.
        if (q.id === "wifiOfferAccepted" && parsed === true) {
            await maybeBeginWifiFlow();
        }
        let prefix = "";
        if (q.id === "claudeOfferAccepted" && parsed === true) {
            maybeFireClaudeLogin();
            // Chromium takes 3-5s to render the OAuth page after spawn;
            // without an immediate acknowledgement the user thinks the
            // chat froze and re-types. The prefix lands on the next
            // question's reply so the user sees "opening sign-in" right
            // away, then continues onboarding while OAuth loads.
            prefix =
                "Opening the Claude sign-in window — it'll pop up in a few seconds. " +
                "While that loads: ";
        }
        const turn = await emitNext(next, trimmed);
        if (prefix !== "") {
            return { ...turn, reply: `${prefix}${turn.reply}` };
        }
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

/**
 * Build the prompt for a question. For most questions this is just the
 * static `q.prompt` string; the timezone question gets a one-time
 * suggestion appended when we're online and the free geo-IP API
 * returns a sensible answer ("Looks like Pacific — sound right?").
 *
 * Soft-fails on every error so a flaky network never blocks onboarding.
 * The auto-detect is gated on `USBELIZA_DISABLE_GEOIP=1` so the test
 * suite (which has no network) doesn't sit through a 2-second timeout
 * on every timezone question.
 */
async function promptFor(q: OnboardingQuestion): Promise<string> {
    if (q.id !== "timezone") return q.prompt;
    if (process.env.USBELIZA_DISABLE_GEOIP === "1") return q.prompt;
    try {
        if (!(await isNmcliAvailable())) return q.prompt;
        const status = await networkStatus();
        if (!status.online) return q.prompt;
        const suggested = await suggestTimezoneFromIp();
        if (suggested === null) return q.prompt;
        return `What timezone are you in? Looks like ${suggested} — sound right?`;
    } catch {
        return q.prompt;
    }
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
    const preset = await promptFor(nextQ);
    return {
        reply: await rephraseOnboardingTurn(
            preset,
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
        case "workFocus":
            return "general";
        case "multitasking":
            return "single-task";
        case "chronotype":
            return "flexible";
        case "errorCommunication":
            return "transparent";
        case "keyboardLayout":
            return "us";
        case "language":
            return "en_US.UTF-8";
        case "timezone":
            return "UTC";
        case "wifiOfferAccepted":
            return false;
        case "claudeOfferAccepted":
            return false;
        default:
            throw new Error(`defaultForSkip: unknown question id ${String(id)}`);
    }
}

/**
 * Fire the multi-turn wifi flow when the user says yes to question 2.
 * Soft-fails — if NetworkManager isn't available (test env / no nmcli),
 * we just continue onboarding and let the user pick this up later.
 */
async function maybeBeginWifiFlow(): Promise<void> {
    // Skip side effects in test runs — the wifi flow is exercised by its
    // own test file with a mocked NetworkManager boundary. The
    // USBELIZA_STATE_DIR override is the standard test-mode signal we
    // use across the codebase.
    if (process.env.USBELIZA_STATE_DIR !== undefined) return;
    try {
        const { beginWifiFlow } = await import("../runtime/flows/wifi-flow.ts");
        await beginWifiFlow();
    } catch {
        // No nmcli, no Wi-Fi card, or a stale flow — don't gate onboarding.
    }
}

/**
 * Fire the LOGIN_CLAUDE action in the background when the user says yes
 * to question 3. We don't await the handler — OAuth can take 30s+ and
 * we want onboarding to continue immediately. The chromium window opens
 * in parallel; when the user completes auth in the browser the token
 * lands at `~/.eliza/auth/claude.json` via the action's poll loop.
 *
 * Soft-fails the same way as the wifi offer.
 */
function maybeFireClaudeLogin(): void {
    if (process.env.USBELIZA_STATE_DIR !== undefined) return;
    void (async () => {
        try {
            const [{ getRuntime }, { LOGIN_CLAUDE_ACTION }] = await Promise.all([
                import("../runtime/eliza.ts"),
                import("../runtime/actions/login-claude.ts"),
            ]);
            const runtime = await getRuntime();
            // Synthesize a minimal Memory shaped like the dispatcher's.
            // The action's handler just uses runtime + memory.content.text;
            // it doesn't need a full chat history.
            const { stringToUuid } = await import("@elizaos/core");
            const memory = {
                id: stringToUuid(`onboarding-claude-${Date.now()}`),
                entityId: stringToUuid("usbeliza-user"),
                agentId: runtime.agentId,
                roomId: stringToUuid("usbeliza-onboarding"),
                content: { text: "log into claude", source: "onboarding" },
                createdAt: Date.now(),
            };
            await LOGIN_CLAUDE_ACTION.handler(runtime, memory, undefined, undefined, async () => []);
        } catch {
            // Fire-and-forget: if claude isn't installed or the runtime
            // hasn't booted, the user can retry from chat later.
        }
    })();
}

function freeformAccept(
    id: keyof CalibrationBlock,
    raw: string,
): CalibrationBlock[OnboardingQuestion["id"]] {
    // For free-text fields (name, workFocus) and the system fields
    // (keyboardLayout / language / timezone — where unrecognized input
    // can still be valid to `localectl`), accept whatever the user
    // typed. For enum fields, fall through to the skip default — that's
    // what they'd get anyway by not answering clearly.
    if (
        id === "name" ||
        id === "workFocus" ||
        id === "keyboardLayout" ||
        id === "language" ||
        id === "timezone"
    ) {
        return raw.slice(0, 256);
    }
    return defaultForSkip(id);
}
