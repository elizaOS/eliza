// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * NetworkManager wrapper (locked decision #24: NetworkManager owns the
 * network surface on the live ISO; chat box drives it via `nmcli`).
 *
 * Phase 1 surface: list and connect to Wi-Fi SSIDs from the chat box.
 * Adding/forgetting connections, switching to ethernet, and the
 * polkit policy for non-sudo nmcli will land in 1.5.
 *
 * The runtime depends on `nmcli` being on PATH and a NetworkManager
 * daemon being reachable (DBus). On the live ISO both come from the
 * `network-manager` apt package shipped via the live-build package
 * list. On the dev VM the qcow2 also has it installed by `mmdebstrap.
 * recipe`. On a host dev box (`just dev`) the user's existing
 * NetworkManager is reused.
 */

import { spawn } from "node:child_process";

// Lazy lookup so tests that override $USBELIZA_NMCLI between imports
// see the new value. Each call re-reads the env.
function nmcliPath(): string {
    return process.env.USBELIZA_NMCLI ?? Bun.env.USBELIZA_NMCLI ?? "nmcli";
}

export class NetworkError extends Error {
    constructor(
        message: string,
        public code: "no-nmcli" | "no-daemon" | "rfkill" | "auth" | "timeout" | "unknown",
    ) {
        super(message);
        this.name = "NetworkError";
    }
}

interface WifiNetwork {
    ssid: string;
    signal: number;
    security: string;
    inUse: boolean;
}

/**
 * Spawn `nmcli` and capture stdout. Falls back to a structured error
 * with a `code` hint so chat.ts can shape a useful reply.
 */
async function runNmcli(args: string[]): Promise<string> {
    return await new Promise((resolve, reject) => {
        const child = spawn(nmcliPath(), args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        child.on("error", (err) => {
            const m = String(err.message);
            if (m.includes("ENOENT")) {
                reject(new NetworkError("nmcli not installed", "no-nmcli"));
            } else {
                reject(new NetworkError(m, "unknown"));
            }
        });
        child.on("close", (code) => {
            if (code === 0) {
                resolve(stdout);
                return;
            }
            const msg = stderr.trim() || `nmcli exited ${code}`;
            if (msg.includes("not running")) {
                reject(new NetworkError("NetworkManager daemon is not running", "no-daemon"));
            } else if (msg.toLowerCase().includes("rfkill") || msg.includes("Wi-Fi is disabled")) {
                reject(new NetworkError("Wi-Fi is hardware-blocked (rfkill)", "rfkill"));
            } else if (msg.toLowerCase().includes("password") || msg.toLowerCase().includes("secrets")) {
                reject(new NetworkError("Wi-Fi authentication failed", "auth"));
            } else {
                reject(new NetworkError(msg, "unknown"));
            }
        });
    });
}

export async function isNmcliAvailable(): Promise<boolean> {
    try {
        await runNmcli(["--version"]);
        return true;
    } catch {
        return false;
    }
}

/**
 * List visible Wi-Fi networks sorted by signal strength (descending).
 * Limits to the top 20 to keep the chat reply concise.
 */
export async function listWifi(): Promise<WifiNetwork[]> {
    // Force a rescan so freshly visible APs show up.
    try {
        await runNmcli(["device", "wifi", "rescan"]);
    } catch {
        // best-effort — rescan can fail if scanning is already in progress
    }
    const raw = await runNmcli([
        "-t",
        "-f",
        "IN-USE,SSID,SIGNAL,SECURITY",
        "device",
        "wifi",
        "list",
    ]);
    return raw
        .split("\n")
        .filter((l) => l.length > 0)
        .map((line) => {
            // nmcli -t output is colon-separated with literal ":" inside
            // SSID escaped as "\:". Split on unescaped colons.
            const fields = line.split(/(?<!\\):/);
            return {
                inUse: fields[0] === "*",
                ssid: (fields[1] ?? "").replace(/\\:/g, ":"),
                signal: parseInt(fields[2] ?? "0", 10),
                security: fields[3] ?? "",
            };
        })
        .filter((n) => n.ssid !== "")
        .sort((a, b) => b.signal - a.signal)
        .slice(0, 20);
}

/**
 * Connect to a Wi-Fi network. If the SSID is already in the saved
 * connections list, nmcli reuses the stored password; otherwise the
 * caller must supply one. Returns the resolved connection name.
 */
export async function connectWifi(ssid: string, password?: string): Promise<string> {
    const args = ["device", "wifi", "connect", ssid];
    if (password !== undefined && password !== "") {
        args.push("password", password);
    }
    const out = await runNmcli(args);
    return out.trim();
}

/**
 * Report the current connection state — used by chat replies and the
 * eliza status surface.
 */
export interface NetworkStatus {
    online: boolean;
    activeSsid: string | null;
    ipv4: string | null;
}

export async function networkStatus(): Promise<NetworkStatus> {
    const conn = (await runNmcli(["-t", "-f", "NAME,TYPE,DEVICE,STATE", "connection", "show", "--active"])).trim();
    const lines = conn.split("\n").filter((l) => l.length > 0);
    const wifi = lines.find((l) => l.includes(":802-11-wireless:"));
    let activeSsid: string | null = null;
    if (wifi !== undefined) {
        const [name] = wifi.split(":");
        activeSsid = name ?? null;
    }
    let ipv4: string | null = null;
    try {
        const dev = (await runNmcli(["-t", "-f", "IP4.ADDRESS", "device", "show"])).trim();
        const match = /IP4\.ADDRESS\[1\]:([0-9.]+)\/\d+/.exec(dev);
        ipv4 = match?.[1] ?? null;
    } catch {
        // ignore
    }
    return {
        online: ipv4 !== null && ipv4 !== "127.0.0.1",
        activeSsid,
        ipv4,
    };
}
