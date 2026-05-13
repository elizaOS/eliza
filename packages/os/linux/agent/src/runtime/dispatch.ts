// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * Chat dispatch over the AgentRuntime.
 *
 * Why we don't call `runtime.processActions` directly: that pipeline expects
 * the planner LLM to pick which Action to fire. With our shipped 1B Llama
 * the planner output is unreliable — actions get skipped or invented. So we
 * do the action *selection* deterministically (similes overlap, the same
 * data the planner would read) and call the chosen `action.handler` with
 * the real `runtime` + a Memory shaped like core's `createMessageMemory`.
 *
 * Everything else flows through real @elizaos/core APIs:
 *  - the Memory is the same shape providers/handlers see in milady,
 *  - the handler signature `(runtime, message, state, options, callback)`
 *    is identical to `terminalAction.handler` etc.,
 *  - chat fallback uses `runtime.useModel(ModelType.TEXT_LARGE)` so any
 *    model provider plugin (local-llama, claude, openai) routes the same way.
 *
 * When we swap the local model for cloud Claude post-auth, this file
 * doesn't change — only the character's settings or the registered model
 * plugin do.
 */

import {
    type Action,
    type ActionResult,
    type Content,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    ModelType,
    stringToUuid,
} from "@elizaos/core";

import { buildSystemPrompt, type CalibrationBlock } from "../persona.ts";
import { continueInstallPackageFlow } from "./flows/install-package-flow.ts";
import {
    beginPersistenceFlow,
    continuePersistenceFlow,
    shouldStartPersistenceFlow,
} from "./flows/persistence-flow.ts";
import { clearFlow, getFlowState, isBailOut } from "./flows/state.ts";
import {
    beginWifiFlow,
    continueWifiFlow,
    shouldStartWifiFlow,
} from "./flows/wifi-flow.ts";
import { matchAction } from "./match.ts";
import { USBELIZA_ACTIONS } from "./plugin.ts";
import { getRuntime } from "./eliza.ts";
import { llmRepliesEnabled, rephraseAsEliza } from "./dispatch-llm.ts";
import { OPEN_URL_ACTION } from "./actions/open-url.ts";
import type { ActionContext } from "./dispatch-llm.ts";

const URL_HINT_RE = /\bhttps?:\/\/\S+/i;

/**
 * Wrap any chat reply through `rephraseAsEliza` when the gate allows.
 * Falls back to `suggestedText` on any failure — flow handlers, bail-out
 * replies, and chat-model error strings all converge on this helper so
 * every visible turn either sounds like Eliza or returns the original
 * intent verbatim.
 */
async function maybeRephrase(
    runtime: IAgentRuntime,
    ctx: ActionContext,
): Promise<string> {
    if (!llmRepliesEnabled()) return ctx.suggestedText;
    try {
        return await rephraseAsEliza(runtime, ctx);
    } catch {
        return ctx.suggestedText;
    }
}

export interface ChatLaunch {
    slug: string;
    manifestPath: string;
    backend: string;
}

export interface DispatchResult {
    reply: string;
    launch: ChatLaunch | null;
    actionName: string | null;
}

const USER_UUID = stringToUuid("usbeliza-user");
const ROOM_UUID = stringToUuid("usbeliza-chat-room");

function memoryFor(text: string, runtime: IAgentRuntime): Memory {
    return {
        id: stringToUuid(`msg-${Date.now()}-${Math.random()}`),
        entityId: USER_UUID,
        agentId: runtime.agentId,
        roomId: ROOM_UUID,
        content: { text, source: "usbeliza-chat" },
        createdAt: Date.now(),
    };
}

async function runAction(
    runtime: IAgentRuntime,
    action: Action,
    message: Memory,
    calibration: CalibrationBlock | null,
): Promise<DispatchResult> {
    let captured: Content | null = null;
    const callback: HandlerCallback = async (response) => {
        captured = response;
        return [];
    };

    const result = (await action.handler(runtime, message, undefined, undefined, callback, [])) as
        | ActionResult
        | undefined;

    const presetReply =
        (captured !== null && typeof (captured as Content).text === "string"
            ? ((captured as Content).text as string)
            : undefined) ??
        (result !== undefined && typeof result.text === "string" ? result.text : "") ??
        "";

    const launch =
        result !== undefined &&
        result.data !== undefined &&
        typeof result.data === "object" &&
        result.data !== null &&
        "launch" in (result.data as Record<string, unknown>)
            ? ((result.data as { launch?: ChatLaunch }).launch ?? null)
            : null;

    // Re-phrase the preset reply through the LLM so Eliza speaks in her
    // own voice rather than returning a hardcoded template. Default-on
    // when Claude/Codex is signed in (fast cloud model); off when only
    // the local 1B is available (would gate every turn on a 10s call).
    // Forced on/off with USBELIZA_LLM_REPLIES env var.
    //
    // Skipped when the action has a `launch` payload — those replies
    // are quick acknowledgements that trigger a window open; the user
    // wants the window NOW, not 5s later after the model rephrases.
    const userText = typeof message.content?.text === "string" ? message.content.text : "";
    const shouldRephrase = launch === null && presetReply.length > 0 && llmRepliesEnabled();
    const reply = shouldRephrase
        ? await rephraseAsEliza(runtime, {
              actionName: action.name,
              userMessage: userText,
              data: result?.data ?? null,
              suggestedText: presetReply,
              calibration,
          })
        : presetReply;

    return { reply, launch, actionName: action.name };
}

async function runChatModel(
    runtime: IAgentRuntime,
    message: Memory,
    calibration: CalibrationBlock | null,
): Promise<DispatchResult> {
    const systemPrompt = buildSystemPrompt(calibration);
    const userText = typeof message.content?.text === "string" ? message.content.text : "";
    // GenerateTextParams (proto) only has `prompt` — no separate `system`
    // field. node-llama-cpp's LlamaChatSession accepts `systemPrompt` via
    // its own API, but the @elizaos/core proto wraps that internally per
    // provider. We pass system + user concatenated; the local-llama-plugin
    // re-extracts the system prefix it placed there.
    try {
        const reply = await runtime.useModel(ModelType.TEXT_LARGE, {
            prompt:
                systemPrompt.length > 0
                    ? `${systemPrompt}\n\nUser: ${userText}`
                    : userText,
            stopSequences: [],
        });
        if (typeof reply !== "string" || reply.trim().length === 0) {
            const fallback = await maybeRephrase(runtime, {
                actionName: "CHAT_EMPTY_REPLY",
                userMessage: userText,
                data: null,
                suggestedText:
                    "I'm here, but my model went quiet on that one. Want to try rephrasing?",
                calibration,
            });
            return { reply: fallback, launch: null, actionName: null };
        }
        return { reply: reply.trim(), launch: null, actionName: null };
    } catch (err) {
        // Local model is unreachable — try to rephrase the error through
        // any other available model (e.g. cloud Claude if signed in).
        // If nothing's available, the helper falls back to the preset.
        const fallback = await maybeRephrase(runtime, {
            actionName: "CHAT_MODEL_ERROR",
            userMessage: userText,
            data: { error: (err as Error).message },
            suggestedText:
                "I can't reach my local model right now — usually it's the bundled Llama on this USB. " +
                "Try `list models` to see what's loaded, or sign into Claude with `login to claude`.",
            calibration,
        });
        return { reply: fallback, launch: null, actionName: null };
    }
}

export interface DispatchInput {
    text: string;
    calibration: CalibrationBlock | null;
}

export async function dispatch(input: DispatchInput): Promise<DispatchResult> {
    const runtime = await getRuntime();
    const message = memoryFor(input.text, runtime);

    // Multi-turn flow path: if a flow is in progress, route the message
    // to its handler BEFORE action selection. Users can bail out at any
    // turn ("cancel" / "never mind") — the dispatcher catches that
    // uniformly so each flow handler doesn't need to repeat the check.
    const flow = getFlowState();
    if (flow !== null) {
        if (isBailOut(input.text)) {
            clearFlow();
            const reply = await maybeRephrase(runtime, {
                actionName: "FLOW_BAIL_OUT",
                userMessage: input.text,
                data: { previousFlowId: flow.flowId },
                suggestedText: "OK, leaving that alone.",
                calibration: input.calibration,
            });
            return { reply, launch: null, actionName: null };
        }
        if (flow.flowId === "wifi-setup") {
            const result = await continueWifiFlow(input.text, flow);
            const reply = await maybeRephrase(runtime, {
                actionName: "WIFI_FLOW",
                userMessage: input.text,
                data: { step: flow.step ?? null, intent: result.reply },
                suggestedText: result.reply,
                calibration: input.calibration,
            });
            return { reply, launch: null, actionName: "WIFI_FLOW" };
        }
        if (flow.flowId === "persistence-setup") {
            const result = await continuePersistenceFlow(input.text, flow);
            const reply = await maybeRephrase(runtime, {
                actionName: "PERSISTENCE_FLOW",
                userMessage: input.text,
                data: { step: flow.step ?? null, intent: result.reply },
                suggestedText: result.reply,
                calibration: input.calibration,
            });
            return { reply, launch: null, actionName: "PERSISTENCE_FLOW" };
        }
        if (flow.flowId === "install-package") {
            const result = await continueInstallPackageFlow(input.text, flow);
            const reply = await maybeRephrase(runtime, {
                actionName: "INSTALL_PACKAGE_FLOW",
                userMessage: input.text,
                data: { step: flow.step ?? null, intent: result.reply },
                suggestedText: result.reply,
                calibration: input.calibration,
            });
            return { reply, launch: null, actionName: "INSTALL_PACKAGE_FLOW" };
        }
    }

    // URL pre-match — any message containing an http(s) URL is an OPEN_URL
    // intent. We override the simile matcher because variants like
    // "go to https://...", "launch https://..." or a bare pasted URL don't
    // hit OPEN_URL's similes. We run this AFTER the flow check so a URL
    // typed mid-flow is still treated as flow continuation (e.g., a
    // pasted passphrase, however unusual).
    if (URL_HINT_RE.test(input.text)) {
        return runAction(runtime, OPEN_URL_ACTION, message, input.calibration);
    }

    // No flow in progress — see if the user wants to START a flow.
    // "connect to wifi" (no SSID) and "set up persistence" enter their
    // respective multi-turn flows here, beating the single-shot
    // CONNECT_WIFI / SETUP_PERSISTENCE actions in the matcher below.
    if (shouldStartWifiFlow(input.text)) {
        const result = await beginWifiFlow();
        const reply = await maybeRephrase(runtime, {
            actionName: "WIFI_FLOW_START",
            userMessage: input.text,
            data: { intent: result.reply },
            suggestedText: result.reply,
            calibration: input.calibration,
        });
        return { reply, launch: null, actionName: "WIFI_FLOW" };
    }
    if (shouldStartPersistenceFlow(input.text)) {
        const result = await beginPersistenceFlow();
        const reply = await maybeRephrase(runtime, {
            actionName: "PERSISTENCE_FLOW_START",
            userMessage: input.text,
            data: { intent: result.reply },
            suggestedText: result.reply,
            calibration: input.calibration,
        });
        return { reply, launch: null, actionName: "PERSISTENCE_FLOW" };
    }

    // Selection: rank usbelizaPlugin's similes against the message + ensure
    // each candidate's validate() agrees. The same Action.similes data the
    // planner LLM would read drives selection here, so when we eventually
    // run on a bigger model we can drop this and call processActions.
    const match = matchAction(input.text, USBELIZA_ACTIONS as unknown as Action[]);
    if (match !== null) {
        const ok = await match.action.validate(runtime, message, undefined);
        if (ok) {
            return runAction(runtime, match.action, message, input.calibration);
        }
    }

    return runChatModel(runtime, message, input.calibration);
}
