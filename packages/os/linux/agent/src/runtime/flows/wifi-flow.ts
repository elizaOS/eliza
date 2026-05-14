// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * Multi-turn Wi-Fi setup flow.
 *
 * Triggered when the user says "connect to wifi" without an SSID.
 * The single-shot CONNECT_WIFI action handles "connect to wifi MyHome
 * password hunter2" already; that fast path keeps winning when both
 * SSID and password are inline. This flow only activates when the
 * SSID is missing, then walks the user through it:
 *
 *   step 0 (entry)            — list visible networks, ask which one.
 *   step "awaiting-ssid"      — match user's reply against listed SSIDs.
 *     → if open:    connect, report IP, clearFlow.
 *     → if WPA:     ask for password.
 *   step "awaiting-password"  — try the password, report success or retry.
 *   step "awaiting-password-retry" — same shape, with attempt counter.
 *     → after 3 tries: bail with a friendly "want to pick a different
 *       network or stop?" and clearFlow.
 *
 * Every step accepts the universal bail words ("cancel" / "stop" /
 * "never mind" / "skip") which clearFlow and return a one-sentence
 * acknowledgement. The dispatcher handles that check before routing
 * here, so this module assumes the message is in-flow.
 *
 * Boundaries (listWifi, connectWifi, networkStatus) are passed in as
 * a `WifiDeps` object so tests can mock them without spawning nmcli.
 */

import {
    type NetworkError,
    type NetworkStatus,
    connectWifi as defaultConnect,
    listWifi as defaultList,
    networkStatus as defaultStatus,
} from "../../network.ts";
import { clearFlow, getFlowState, setFlow, type FlowState } from "./state.ts";

export interface WifiNetwork {
    ssid: string;
    signal: number;
    security: string;
    inUse: boolean;
}

export interface WifiDeps {
    readonly listWifi: () => Promise<WifiNetwork[]>;
    readonly connectWifi: (ssid: string, password?: string) => Promise<string>;
    readonly networkStatus: () => Promise<NetworkStatus>;
}

const DEFAULT_DEPS: WifiDeps = {
    listWifi: defaultList,
    connectWifi: defaultConnect,
    networkStatus: defaultStatus,
};

const MAX_PASSWORD_ATTEMPTS = 3;

/**
 * Match the user's reply against the previously-listed networks. We
 * accept any substring of one of the SSIDs (case-insensitive) — if
 * the user typed exactly one of the listed SSIDs it wins outright,
 * otherwise we look for a unique prefix or substring match. Returns
 * `null` when the reply is ambiguous (matches more than one) or
 * misses entirely (matches none).
 */
export function matchSsidReply(reply: string, ssids: readonly string[]): string | null {
    const norm = reply.trim().toLowerCase();
    if (norm === "") return null;
    // Exact match wins outright (case-insensitive).
    for (const s of ssids) {
        if (s.toLowerCase() === norm) return s;
    }
    // Prefix match: only one network whose lowercase starts with the reply.
    const prefix = ssids.filter((s) => s.toLowerCase().startsWith(norm));
    if (prefix.length === 1 && prefix[0] !== undefined) return prefix[0];
    // Substring match: only one network containing the reply.
    const sub = ssids.filter((s) => s.toLowerCase().includes(norm));
    if (sub.length === 1 && sub[0] !== undefined) return sub[0];
    return null;
}

/**
 * Compose the "I see N networks: …" sentence. Conversational prose,
 * not a list. Mentions the strongest signal explicitly so the user
 * has a default to pick. Caps at 3 names to keep the line short.
 */
export function describeNetworks(networks: readonly WifiNetwork[]): string {
    if (networks.length === 0) {
        return "I don't see any wifi networks in range — bring me closer to your router and try again.";
    }
    if (networks.length === 1) {
        const n0 = networks[0];
        if (n0 === undefined) return "Nothing in range.";
        const sec = n0.security === "" ? "open" : "password-protected";
        return `I see one: ${n0.ssid} (${n0.signal}%, ${sec}). Want to connect?`;
    }
    const top = networks.slice(0, 3);
    const names = top.map((n) => n.ssid);
    if (networks.length === 2) {
        return `I see two: ${names[0]} has the strongest signal, then ${names[1]}. Which would you like?`;
    }
    if (networks.length === 3) {
        return `I see three: ${names[0]} has the strongest signal, then ${names[1]} and ${names[2]}. Which would you like?`;
    }
    return `I see ${networks.length} networks. The strongest are ${names[0]}, ${names[1]}, and ${names[2]}. Which would you like?`;
}

export interface WifiFlowReply {
    readonly reply: string;
    /** True when this turn ended the flow (success, bail, or hard failure). */
    readonly done: boolean;
}

/**
 * Entry point — called from dispatch.ts when the user says "connect
 * to wifi" or similar without an inline SSID. Lists networks, sets
 * step to "awaiting-ssid", returns the prompt.
 */
export async function beginWifiFlow(
    deps: WifiDeps = DEFAULT_DEPS,
): Promise<WifiFlowReply> {
    let networks: WifiNetwork[];
    try {
        networks = await deps.listWifi();
    } catch (err) {
        const code = (err as NetworkError).code ?? "unknown";
        if (code === "no-nmcli") {
            return {
                reply: "I can't manage Wi-Fi — nmcli isn't on this system.",
                done: true,
            };
        }
        if (code === "no-daemon") {
            return {
                reply: "I can't manage Wi-Fi — NetworkManager isn't running.",
                done: true,
            };
        }
        if (code === "rfkill") {
            return {
                reply:
                    "I can't see Wi-Fi — it's hardware-blocked. Toggle the Wi-Fi switch on your laptop and ask me again.",
                done: true,
            };
        }
        return {
            reply: `I couldn't list networks: ${(err as Error).message}.`,
            done: true,
        };
    }
    if (networks.length === 0) {
        return {
            reply: describeNetworks(networks),
            done: true,
        };
    }
    setFlow({
        schema_version: 1,
        flowId: "wifi-setup",
        step: "awaiting-ssid",
        data: { networks: networks.map((n) => n.ssid) },
        updatedAt: Date.now(),
    });
    return { reply: describeNetworks(networks), done: false };
}

async function handleAwaitingSsid(
    message: string,
    state: FlowState,
    deps: WifiDeps,
): Promise<WifiFlowReply> {
    const ssids = Array.isArray(state.data.networks)
        ? (state.data.networks as unknown[]).filter((s) => typeof s === "string") as string[]
        : [];
    const matched = matchSsidReply(message, ssids);
    if (matched === null) {
        // Stay in the same step; gently re-ask without rebuilding the
        // full network list (too long to repeat each turn).
        return {
            reply: `I'm not sure which one — try one of these names: ${ssids.slice(0, 3).join(", ")}. Or say "cancel" to stop.`,
            done: false,
        };
    }
    // Re-list to find the matched network's security flag.
    let security = "";
    try {
        const networks = await deps.listWifi();
        const found = networks.find((n) => n.ssid === matched);
        security = found?.security ?? "";
    } catch {
        // best-effort — assume protected on error to be safe.
        security = "WPA2";
    }
    if (security === "") {
        // Open network — connect now.
        return await tryConnect(matched, undefined, deps, state);
    }
    setFlow({
        schema_version: 1,
        flowId: "wifi-setup",
        step: "awaiting-password",
        data: { networks: ssids, ssid: matched, attempts: 0 },
        updatedAt: Date.now(),
    });
    return {
        reply: `${matched} needs a password — what is it?`,
        done: false,
    };
}

async function tryConnect(
    ssid: string,
    password: string | undefined,
    deps: WifiDeps,
    state: FlowState,
): Promise<WifiFlowReply> {
    try {
        await deps.connectWifi(ssid, password);
        let ipNote = "";
        try {
            const status = await deps.networkStatus();
            if (status.ipv4 !== null) ipNote = ` IP ${status.ipv4}.`;
        } catch {
            // best-effort
        }
        clearFlow();
        return { reply: `Connected to ${ssid}.${ipNote}`, done: true };
    } catch (err) {
        const code = (err as NetworkError).code ?? "unknown";
        if (code === "auth") {
            const prior = typeof state.data.attempts === "number" ? state.data.attempts : 0;
            const attempts = prior + 1;
            if (attempts >= MAX_PASSWORD_ATTEMPTS) {
                clearFlow();
                return {
                    reply:
                        `That's three tries on ${ssid}. The network kept rejecting the password. ` +
                        `Want to start over — say "connect to wifi" and pick again.`,
                    done: true,
                };
            }
            setFlow({
                schema_version: 1,
                flowId: "wifi-setup",
                step: "awaiting-password-retry",
                data: {
                    networks: state.data.networks,
                    ssid,
                    attempts,
                },
                updatedAt: Date.now(),
            });
            return {
                reply:
                    "Wrong password, or the network rejected it. Want to try again, or pick a different network?",
                done: false,
            };
        }
        clearFlow();
        return {
            reply: `I couldn't connect to ${ssid}: ${(err as Error).message}.`,
            done: true,
        };
    }
}

async function handleAwaitingPassword(
    message: string,
    state: FlowState,
    deps: WifiDeps,
): Promise<WifiFlowReply> {
    const ssid = typeof state.data.ssid === "string" ? state.data.ssid : "";
    if (ssid === "") {
        clearFlow();
        return { reply: "I lost track of which network — try again from the top.", done: true };
    }
    const password = message.trim();
    if (password === "") {
        return { reply: "Type the password and send.", done: false };
    }
    return await tryConnect(ssid, password, deps, state);
}

async function handleAwaitingRetry(
    message: string,
    state: FlowState,
    deps: WifiDeps,
): Promise<WifiFlowReply> {
    // After an auth failure: the user typically just types another password.
    // If they instead say "different network" or similar, restart the
    // listing step. Anything else is treated as a fresh password attempt.
    const norm = message.trim().toLowerCase();
    if (
        norm.includes("different network") ||
        norm.includes("another network") ||
        norm.includes("pick a different") ||
        norm.includes("restart")
    ) {
        return await beginWifiFlow(deps);
    }
    return await handleAwaitingPassword(message, state, deps);
}

/**
 * Continue an in-progress wifi flow. Called by dispatch.ts when
 * `getFlowState()` returns a flow whose id is "wifi-setup". The bail
 * check happens in dispatch.ts (uniform across all flows), so this
 * function assumes the message is a legitimate in-flow answer.
 */
export async function continueWifiFlow(
    message: string,
    state: FlowState,
    deps: WifiDeps = DEFAULT_DEPS,
): Promise<WifiFlowReply> {
    if (state.flowId !== "wifi-setup") {
        return { reply: "I lost track — start over with 'connect to wifi'.", done: true };
    }
    switch (state.step) {
        case "awaiting-ssid":
            return await handleAwaitingSsid(message, state, deps);
        case "awaiting-password":
            return await handleAwaitingPassword(message, state, deps);
        case "awaiting-password-retry":
            return await handleAwaitingRetry(message, state, deps);
        default:
            // Unknown step — bail cleanly.
            clearFlow();
            return {
                reply: "I lost track of where we were. Try 'connect to wifi' again.",
                done: true,
            };
    }
}

/**
 * Detect the "start a wifi flow" intent from a free-text message.
 * True ONLY when the user says something like "connect to wifi" / "get
 * me online" / "join a network" without supplying an SSID. The
 * single-shot CONNECT_WIFI action handles the with-SSID case via
 * matchAction → similes scoring; this predicate is the no-SSID gate.
 *
 * The dispatcher checks this BEFORE matchAction, so a positive return
 * value takes precedence — but only when nothing in the message looks
 * like an SSID + password ("connect to wifi MyHome password X").
 */
export function shouldStartWifiFlow(message: string): boolean {
    const norm = message.trim().toLowerCase();
    if (norm === "") return false;
    // Phrases that imply "I want internet, walk me through it":
    const triggers = [
        "connect to wifi",
        "connect to wi-fi",
        "connect wifi",
        "connect to a network",
        "join wifi",
        "join a network",
        "join the wifi",
        "get me online",
        "get online",
        "set up wifi",
        "set up wi-fi",
        "setup wifi",
        "help me get online",
    ];
    let triggered = false;
    for (const t of triggers) {
        if (norm.includes(t)) {
            triggered = true;
            break;
        }
    }
    if (!triggered) return false;
    // If the user supplied a password inline ("connect to wifi MyHome
    // password hunter2"), let the single-shot CONNECT_WIFI action take
    // it — the multi-turn flow is for the lazy case.
    if (norm.includes(" password ") || norm.includes(" with password ")) {
        return false;
    }
    // If the user supplied an SSID inline ("connect to wifi MyHome"),
    // we let CONNECT_WIFI win — it'll prompt nmcli which already knows
    // saved networks, otherwise the action returns an auth error and
    // the user can rerun with a password.
    //
    // Heuristic: any word after "wifi" / "network" that isn't a filler
    // counts as an SSID and disables the multi-turn flow. Keep the
    // filler list tight — same words wifi.ts already strips.
    const tokens = norm.split(/\s+/);
    const idx = tokens.findIndex(
        (t) => t === "wifi" || t === "wi-fi" || t === "network" || t === "online",
    );
    const FILLERS = new Set([
        "for", "me", "now", "please", "thanks", "to", "a", "an", "the",
    ]);
    for (let i = idx + 1; i < tokens.length; i++) {
        const tok = tokens[i];
        if (tok === undefined) continue;
        if (FILLERS.has(tok)) continue;
        // Found a non-filler token after the wifi/network keyword — likely SSID.
        return false;
    }
    return true;
}

/**
 * Tiny re-export of state helpers so dispatch.ts can do flow lookup
 * without importing two modules.
 */
export { getFlowState, clearFlow };
