// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * Persistent multi-turn flow state.
 *
 * Each chat turn is a stateless /api/chat request, so any conversational
 * flow that spans more than one user message — "connect to wifi" →
 * "what's the password?" → "hunter2" — needs to write its progress to
 * disk so the next turn can resume. This module is the storage layer.
 *
 * Shape mirrors `onboarding/state.ts` (same TOML serialization style,
 * same atomic write-rename), but carries a `flowId` discriminator + a
 * free-form `answers` map so each flow handler tracks its own data.
 *
 * Persisted to `~/.eliza/flow.toml`. The dispatch layer reads this
 * file on every chat turn BEFORE running similes-based action matching:
 * if a flow is in progress, its handler claims the turn unconditionally.
 * Users can bail out of any flow with "never mind" / "cancel" / "stop" /
 * "skip" — the handler clears the file and falls through to normal
 * dispatch on the next turn.
 *
 * Path resolution mirrors `onboarding/state.ts` (USBELIZA_STATE_DIR
 * override → `~/.eliza/`) so the live ISO's encrypted persistence
 * partition picks this up via the same bind-mount.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Discriminator for the active flow. Add a new id here when adding a new flow. */
export type FlowId = "wifi-setup" | "persistence-setup" | "install-package";

export interface FlowState {
    readonly schema_version: 1;
    readonly flowId: FlowId;
    /** Step within the flow's own state machine — opaque to this module. */
    readonly step: string;
    /** Per-flow scratch data. Values are JSON-serializable primitives or arrays. */
    readonly data: Record<string, unknown>;
    /** Timestamp of the last update — used to expire stale flows after 30 min. */
    readonly updatedAt: number;
}

const FLOW_EXPIRY_MS = 30 * 60 * 1000;

function stateRoot(): string {
    const explicit = process.env.USBELIZA_STATE_DIR;
    if (explicit !== undefined && explicit !== "") return explicit;
    return join(homedir(), ".eliza");
}

export function flowStatePath(): string {
    return join(stateRoot(), "flow.toml");
}

/**
 * Load the active flow state. Returns `null` when no flow file exists
 * or the file is older than 30 minutes (stale flows are silently
 * cleared to avoid leaving a half-typed passphrase prompt waiting for
 * input across reboots).
 */
export function getFlowState(): FlowState | null {
    const path = flowStatePath();
    if (!existsSync(path)) return null;
    const text = readFileSync(path, "utf8");
    const parsed = parseTomlFlow(text);
    if (parsed === null) return null;
    if (Date.now() - parsed.updatedAt > FLOW_EXPIRY_MS) {
        try {
            unlinkSync(path);
        } catch {
            // best-effort
        }
        return null;
    }
    return parsed;
}

/**
 * Persist a flow state atomically. Setting `updatedAt` is the caller's
 * responsibility on each update so stale-detection works; helpers in
 * each flow handler should always include `updatedAt: Date.now()`.
 */
export function setFlow(state: FlowState): void {
    const path = flowStatePath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, serializeTomlFlow(state));
    require("node:fs").renameSync(tmp, path);
}

/** Delete the flow file. Idempotent — calling on a missing file is a no-op. */
export function clearFlow(): void {
    const path = flowStatePath();
    if (!existsSync(path)) return;
    try {
        unlinkSync(path);
    } catch {
        // best-effort
    }
}

/**
 * Common bail-out words that any flow handler should treat as
 * "abandon this conversation, fall through to normal dispatch". Kept
 * here as a shared constant so wifi-flow and persistence-flow agree.
 */
const BAIL_WORDS = ["never mind", "nevermind", "cancel", "stop", "skip", "abort", "quit"];

export function isBailOut(message: string): boolean {
    const norm = message.trim().toLowerCase();
    if (norm === "") return false;
    for (const w of BAIL_WORDS) {
        if (norm === w || norm.startsWith(w + " ") || norm.startsWith(w + ".")) return true;
    }
    return false;
}

// ─── Minimal TOML serialization (avoid pulling a full toml dep) ──────────

function serializeTomlFlow(state: FlowState): string {
    const lines = [
        `schema_version = ${state.schema_version}`,
        `flow_id = ${JSON.stringify(state.flowId)}`,
        `step = ${JSON.stringify(state.step)}`,
        `updated_at = ${state.updatedAt}`,
        "",
        "[data]",
    ];
    for (const [k, v] of Object.entries(state.data)) {
        if (v === undefined) continue;
        if (typeof v === "string") {
            lines.push(`${k} = ${JSON.stringify(v)}`);
        } else if (typeof v === "number" || typeof v === "boolean") {
            lines.push(`${k} = ${JSON.stringify(v)}`);
        } else if (Array.isArray(v)) {
            // Only string arrays are supported; arbitrary objects would
            // require a real TOML encoder. The wifi flow stores SSID
            // lists (string[]) and that's all we need for now.
            const strs = v.filter((x) => typeof x === "string") as string[];
            lines.push(`${k} = [${strs.map((s) => JSON.stringify(s)).join(", ")}]`);
        } else {
            // Skip unrepresentable values rather than crashing.
            continue;
        }
    }
    return lines.join("\n") + "\n";
}

function parseTomlFlow(text: string): FlowState | null {
    let flowId: string | undefined;
    let step: string | undefined;
    let updatedAt = 0;
    const data: Record<string, unknown> = {};
    let section: "root" | "data" = "root";
    for (const rawLine of text.split("\n")) {
        const line = rawLine.trim();
        if (line === "" || line.startsWith("#")) continue;
        if (line === "[data]") {
            section = "data";
            continue;
        }
        const m = /^([A-Za-z_][\w]*)\s*=\s*(.+)$/.exec(line);
        if (m === null || m[1] === undefined || m[2] === undefined) continue;
        const key = m[1];
        const raw = m[2].trim();
        if (section === "root") {
            if (key === "flow_id") flowId = unquote(raw);
            else if (key === "step") step = unquote(raw);
            else if (key === "updated_at") {
                const n = parseInt(raw, 10);
                if (!Number.isNaN(n)) updatedAt = n;
            }
            continue;
        }
        // section === "data"
        if (raw.startsWith("[")) {
            // Array — split on top-level commas; only string elements.
            const inside = raw.slice(1, raw.lastIndexOf("]"));
            const parts: string[] = [];
            let buf = "";
            let inStr = false;
            for (const ch of inside) {
                if (ch === '"') inStr = !inStr;
                if (ch === "," && !inStr) {
                    parts.push(buf.trim());
                    buf = "";
                } else {
                    buf += ch;
                }
            }
            if (buf.trim() !== "") parts.push(buf.trim());
            data[key] = parts.map((p) => unquote(p));
        } else if (raw.startsWith('"')) {
            data[key] = JSON.parse(raw);
        } else if (raw === "true" || raw === "false") {
            data[key] = raw === "true";
        } else {
            const n = Number(raw);
            if (!Number.isNaN(n)) {
                data[key] = n;
            } else {
                data[key] = raw;
            }
        }
    }
    if (flowId === undefined || step === undefined) return null;
    if (
        flowId !== "wifi-setup" &&
        flowId !== "persistence-setup" &&
        flowId !== "install-package"
    ) {
        return null;
    }
    return {
        schema_version: 1,
        flowId,
        step,
        data,
        updatedAt,
    };
}

function unquote(raw: string): string {
    if (raw.startsWith('"') && raw.endsWith('"')) return JSON.parse(raw) as string;
    return raw;
}
