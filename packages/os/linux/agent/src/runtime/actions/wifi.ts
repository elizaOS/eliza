// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * Wi-Fi actions: LIST_WIFI, CONNECT_WIFI, NETWORK_STATUS.
 *
 * Wraps the existing `network.ts` nmcli wrapper as proper @elizaos/core
 * Actions. The match-quality of the deterministic similes-matcher is good
 * enough for these because the verbs are unambiguous ("connect to wifi X",
 * "list wifi", "am i online").
 */

import type { Action, IAgentRuntime, Memory } from "@elizaos/core";

import {
    connectWifi,
    isNmcliAvailable,
    listWifi,
    type NetworkError,
    networkStatus,
} from "../../network.ts";
import { normalize } from "../match.ts";

function textOf(message: Memory): string {
    return typeof message.content?.text === "string" ? message.content.text : "";
}

function shapeNetworkError(err: unknown, action: string): string {
    const ne = err as NetworkError;
    switch (ne.code ?? "unknown") {
        case "no-nmcli":
            return `I can't ${action} — nmcli isn't on this system.`;
        case "no-daemon":
            return `I can't ${action} — NetworkManager isn't running.`;
        case "rfkill":
            return `I can't ${action} — Wi-Fi is hardware-blocked. Toggle the Wi-Fi switch on your machine.`;
        default:
            return `Failed to ${action}: ${(err as Error).message}.`;
    }
}

export const LIST_WIFI_ACTION: Action = {
    name: "LIST_WIFI",
    similes: [
        "list wifi",
        "list wi-fi",
        "list networks",
        "show wifi",
        "show networks",
        "what wifi",
        "what networks",
        "show wireless",
    ],
    description: "List visible Wi-Fi networks via nmcli.",

    validate: async () => true,

    handler: async (_runtime, _message, _state, _options, callback) => {
        if (!(await isNmcliAvailable())) {
            const text = "I can't see Wi-Fi controls right now — nmcli isn't available on this system.";
            if (callback) await callback({ text, actions: ["LIST_WIFI"] });
            return { success: false, text };
        }
        try {
            const networks = await listWifi();
            if (networks.length === 0) {
                const text = "No Wi-Fi networks visible right now.";
                if (callback) await callback({ text, actions: ["LIST_WIFI"] });
                return { success: true, text };
            }
            const lines = networks.map((n) => {
                const marker = n.inUse ? "★" : " ";
                const sec = n.security !== "" ? ` [${n.security}]` : "";
                return `${marker} ${n.ssid} — ${n.signal}%${sec}`;
            });
            const text =
                `Visible networks:\n${lines.join("\n")}\n\n` +
                'Say "connect to wifi <SSID> password <password>" to join one.';
            if (callback) await callback({ text, actions: ["LIST_WIFI"] });
            return { success: true, text };
        } catch (err) {
            const text = shapeNetworkError(err, "list networks");
            return { success: false, text };
        }
    },
};

const WIFI_KEYWORDS = ["wifi", "wi-fi", "network", "wireless"];

function extractWifiTarget(text: string): { ssid: string; password?: string } | null {
    const tokens = normalize(text);
    if (tokens.length < 2) return null;
    const lower = text.toLowerCase();
    const verb = tokens[0];
    if (verb !== "connect" && verb !== "join") return null;
    if (!WIFI_KEYWORDS.some((k) => lower.includes(k))) {
        return null;
    }

    // Strip "to/the/my/wifi/wi-fi/network/wireless" leading tokens.
    let i = 1;
    while (i < tokens.length) {
        const t = tokens[i];
        if (t === undefined) break;
        if (
            t === "to" ||
            t === "the" ||
            t === "my" ||
            t === "wifi" ||
            t === "wi-fi" ||
            t === "network" ||
            t === "wireless"
        ) {
            i++;
            continue;
        }
        break;
    }

    // Find password separator if present.
    let passwordStart = -1;
    for (let j = i; j < tokens.length; j++) {
        const t = tokens[j];
        if (t === "password" || t === "with" || t === "using") {
            passwordStart = j;
            break;
        }
    }

    const ssidTokens = passwordStart === -1 ? tokens.slice(i) : tokens.slice(i, passwordStart);
    const ssid = ssidTokens.join(" ").trim();
    if (ssid.length === 0 || ssid.length > 64) return null;

    if (passwordStart === -1) return { ssid };
    const pw = tokens.slice(passwordStart + 1).join(" ").trim();
    return pw.length > 0 ? { ssid, password: pw } : { ssid };
}

export const CONNECT_WIFI_ACTION: Action = {
    name: "CONNECT_WIFI",
    similes: [
        "connect to wifi",
        "join wifi",
        "connect to network",
        "join network",
        "connect wifi",
        "join the wifi",
    ],
    description:
        "Connect to a Wi-Fi network. Used when the user says 'connect to wifi <name> " +
        "password <password>' or 'join <name>'.",

    validate: async (_runtime: IAgentRuntime, message: Memory) =>
        extractWifiTarget(textOf(message)) !== null,

    handler: async (_runtime, message, _state, _options, callback) => {
        const parsed = extractWifiTarget(textOf(message));
        if (parsed === null) {
            return { success: false, text: "I couldn't parse the Wi-Fi network name." };
        }
        if (!(await isNmcliAvailable())) {
            const text = "I can't manage Wi-Fi right now — nmcli isn't available on this system.";
            if (callback) await callback({ text, actions: ["CONNECT_WIFI"] });
            return { success: false, text };
        }
        try {
            await connectWifi(parsed.ssid, parsed.password);
            const status = await networkStatus();
            const ip = status.ipv4 !== null ? ` IP ${status.ipv4}.` : "";
            const text = `Connected to ${parsed.ssid}.${ip}`;
            if (callback) await callback({ text, actions: ["CONNECT_WIFI"] });
            return { success: true, text };
        } catch (err) {
            const ne = err as NetworkError;
            if (ne.code === "auth") {
                const text = `Wrong password for ${parsed.ssid}. Try "connect to wifi ${parsed.ssid} password <correct>".`;
                return { success: false, text };
            }
            return { success: false, text: shapeNetworkError(err, `connect to ${parsed.ssid}`) };
        }
    },
};

export const NETWORK_STATUS_ACTION: Action = {
    name: "NETWORK_STATUS",
    similes: [
        "am i online",
        "are we online",
        "network status",
        "connection status",
        "whats my ip",
        "what is my ip",
        "what ip do i have",
        "whats my network",
        "what is my network",
        "is the network up",
        "is wifi up",
        "are we connected",
        "am i connected",
        "is internet working",
        "do i have internet",
    ],
    description: "Report whether the live USB is online and its current IP.",

    validate: async () => true,

    handler: async (_runtime, _message, _state, _options, callback) => {
        if (!(await isNmcliAvailable())) {
            const text = "I don't have a network manager on this system.";
            if (callback) await callback({ text, actions: ["NETWORK_STATUS"] });
            return { success: false, text };
        }
        try {
            const status = await networkStatus();
            if (!status.online) {
                const text =
                    'Offline. Say "list wifi networks" to see what\'s in range, ' +
                    'then "connect to wifi <name> password <password>".';
                if (callback) await callback({ text, actions: ["NETWORK_STATUS"] });
                return { success: true, text };
            }
            const ssid = status.activeSsid !== null ? ` on ${status.activeSsid}` : "";
            const text = `Online${ssid}. IP ${status.ipv4}.`;
            if (callback) await callback({ text, actions: ["NETWORK_STATUS"] });
            return { success: true, text };
        } catch (err) {
            return { success: false, text: shapeNetworkError(err, "check status") };
        }
    },
};
