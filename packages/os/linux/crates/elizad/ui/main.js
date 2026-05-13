// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/*
 * Elizad chat UI — a thin surface over the agent.
 *
 * Architecture (post-v10): the agent is the single source of truth for
 * onboarding state, calibration data, multi-turn flows, and chat replies.
 * This UI just:
 *
 *   1. On boot, opens the chat surface within ~5s and queues any user
 *      input until /api/status reports `state: "ready"` (locked decision
 *      #15: splash chat is mandatory).
 *   2. Sends an empty trigger message to /api/chat once the agent is up.
 *      That empty message is the "first chat-box open" signal the agent
 *      uses to kick off the conversational onboarding flow (greeting +
 *      Q1 name; agent advances state-machine on each subsequent turn).
 *   3. For every user submit, POSTs the message to /api/chat via the
 *      Tauri `chat` command, appends both turns to the transcript.
 *      Optional `launch.slug` in the response triggers a sandboxed app
 *      launch.
 *
 * There is NO JS-side calibration question array, no choice buttons, no
 * "thinking" indicator beyond the input placeholder. The chat IS the
 * desktop and the conversation IS the system. Every onboarding question
 * arrives as a chat turn from Eliza herself; every answer is a chat turn
 * the user types. Multi-turn flows (wifi pick → password, persistence
 * passphrase capture) are also driven entirely by the agent.
 *
 * Pure vanilla JS by design: no bundler in Phase 0. We rely on
 * `withGlobalTauri: true` in tauri.conf.json so `window.__TAURI__.core.invoke`
 * is available without ESM imports.
 */

const TAURI = (() => {
    if (typeof window === "undefined" || !window.__TAURI__) {
        // Browser preview without Tauri — return a polyfill that explains the
        // no-op. Useful for static UI inspection; commands will gracefully fail.
        return {
            invoke() {
                return Promise.reject(new Error("not running inside Tauri"));
            },
        };
    }
    return window.__TAURI__.core;
})();

const STATUS_POLL_INTERVAL_MS = 250;

const els = {
    transcript: document.getElementById("transcript"),
    composer: document.getElementById("composer"),
    input: document.getElementById("input"),
};

/* Chat IS the desktop — no persistent status chrome. The "thinking"
 * signal piggybacks on the input field's placeholder text: while a chat
 * request is in flight, the placeholder reads `…`; when idle, it carries
 * the prompt-suggestion. */
const READY_PLACEHOLDER = "Talk to Eliza…";
const THINKING_PLACEHOLDER = "…";
let restingPlaceholder = "";

/* ----- Transcript helpers ----- */

function appendTurn(role, text) {
    const div = document.createElement("div");
    div.className = `turn ${role}`;
    div.textContent = text;
    els.transcript.appendChild(div);
    div.scrollIntoView({ behavior: "smooth", block: "end" });
    return div;
}

function setComposerEnabled(enabled, placeholder) {
    els.input.disabled = !enabled;
    const next = placeholder ?? "";
    els.input.placeholder = next;
    restingPlaceholder = next;
    if (enabled) {
        els.input.focus();
    }
}

/** Toggle the "Eliza is thinking" affordance: input placeholder becomes
 * the ellipsis while `thinking=true`, otherwise restores the prompt
 * suggestion captured at the last `setComposerEnabled`. */
function setThinking(thinking) {
    if (thinking) {
        els.input.placeholder = THINKING_PLACEHOLDER;
    } else {
        els.input.placeholder = restingPlaceholder;
    }
}

/* ----- Splash-chat queue ----- */

const splashQueue = [];
let agentReady = false;

async function pollAgentStatusUntilReady() {
    while (!agentReady) {
        let status = "booting";
        try {
            status = await TAURI.invoke("agent_status");
        } catch {
            // No-op; try again.
        }
        if (status === "ready") {
            agentReady = true;
            await drainSplashQueue();
            return;
        }
        // "crashed" is treated the same as "booting" — supervisor restarts.
        await sleep(STATUS_POLL_INTERVAL_MS);
    }
}

async function drainSplashQueue() {
    while (splashQueue.length > 0) {
        const { message, placeholder } = splashQueue.shift();
        placeholder?.classList.remove("queued");
        await sendMessageToAgent(message, placeholder);
    }
}

/* ----- Chat round-trip ----- */

async function sendMessageToAgent(message, optimisticUserTurn) {
    let response;
    setThinking(true);
    try {
        response = await TAURI.invoke("chat", { message });
    } catch (err) {
        setThinking(false);
        appendTurn("system", `(${String(err)})`);
        return;
    }
    setThinking(false);
    // The optimistic user turn is already on the transcript; don't dup.
    void optimisticUserTurn;
    // Eliza-agent's `/api/chat` returns either a bare reply string (legacy
    // shape) or a structured ChatResponse `{schema_version, reply, launch?}`.
    if (typeof response === "string") {
        appendTurn("eliza", response);
        return;
    }
    if (response && typeof response.reply === "string") {
        appendTurn("eliza", response.reply);
        if (response.launch && typeof response.launch.slug === "string") {
            await launchApp(response.launch.slug);
        }
        return;
    }
    appendTurn("system", "(unexpected reply shape)");
}

async function launchApp(slug) {
    try {
        await TAURI.invoke("launch_app", { slug });
        appendTurn("system", `(opening ${slug})`);
    } catch (err) {
        appendTurn("system", `(could not launch ${slug}: ${String(err)})`);
    }
}

function bindChatComposer() {
    setComposerEnabled(true, READY_PLACEHOLDER);
    els.composer.addEventListener("submit", async (event) => {
        event.preventDefault();
        const message = els.input.value.trim();
        if (message.length === 0) {
            return;
        }
        els.input.value = "";
        const userTurn = appendTurn("user", message);

        if (!agentReady) {
            userTurn.classList.add("queued");
            splashQueue.push({ message, placeholder: userTurn });
            return;
        }
        await sendMessageToAgent(message, userTurn);
    });
}

/* ----- Boot ----- */

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function main() {
    // Open the composer immediately so the user feels the chat is alive,
    // but disable input until we've fetched the agent's first message.
    setComposerEnabled(false, READY_PLACEHOLDER);

    // Kick the status poller. The agent boots in parallel (typically
    // ~10s); once it reports `ready` the splash queue drains.
    pollAgentStatusUntilReady();

    // Bind the composer so the user can start typing even before the
    // greeting lands. Submitted messages queue and replay.
    bindChatComposer();

    // Fire the empty "first chat-box open" trigger as soon as the agent
    // is ready. The agent's onboarding state-machine answers with the
    // greeting + first question (or with "Welcome back, <name>" if
    // calibration.toml already exists). Either way, the chat surface is
    // exactly that — a conversation from turn one.
    await waitForAgentReady();
    await sendMessageToAgent("", null);
    setComposerEnabled(true, READY_PLACEHOLDER);
}

async function waitForAgentReady() {
    while (!agentReady) {
        await sleep(STATUS_POLL_INTERVAL_MS);
    }
}

main();
