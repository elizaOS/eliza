// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * Status actions: BATTERY_STATUS, CURRENT_TIME.
 *
 * Both are *pure chat responders* — the user asks Eliza "what's my battery"
 * or "what time is it" and gets one sentence of warm prose back. There is
 * no app surface, no GTK window, no UI artifact. Same pattern as the HELP
 * action in `system.ts`: validate true, read whatever the host has, reply.
 *
 * Path roots are injectable via environment variables so the tests don't
 * need to mock node:fs at the module level — they just point the action at
 * a temp tree.
 *
 *   - USBELIZA_POWER_SUPPLY_ROOT   → /sys/class/power_supply on real Linux
 *   - USBELIZA_CALIBRATION_FILE    → ~/.eliza/calibration.toml otherwise
 *
 * The timezone field on `CalibrationBlock` is optional (Track X is adding
 * it as a system-question answer). When the file is missing or malformed
 * we fall back to the system default timezone, which matches the rest of
 * the agent's "calibration shapes the prompt but never gates" stance.
 */

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Action } from "@elizaos/core";

// ─── Filesystem path resolution (env-overridable for tests) ─────────────

/** Root that holds `BAT0/`, `BAT1/`, ... Defaults to `/sys/class/power_supply`. */
export function powerSupplyRoot(): string {
    const explicit = process.env.USBELIZA_POWER_SUPPLY_ROOT;
    if (explicit !== undefined && explicit !== "") return explicit;
    return "/sys/class/power_supply";
}

/** Path to the calibration.toml. Mirrors `onboarding/state.ts::stateRoot`. */
export function calibrationFile(): string {
    const explicit = process.env.USBELIZA_CALIBRATION_FILE;
    if (explicit !== undefined && explicit !== "") return explicit;
    const stateDir = process.env.USBELIZA_STATE_DIR;
    const root = stateDir !== undefined && stateDir !== "" ? stateDir : join(homedir(), ".eliza");
    return join(root, "calibration.toml");
}

// ─── BATTERY_STATUS ─────────────────────────────────────────────────────

/**
 * Read every `BAT*` directory's `capacity` + `status` (+ optional
 * `energy_now`/`energy_full`/`power_now`). When the system has no battery
 * (desktop, AC-only laptop, VM) the directory simply has no `BAT*`
 * entries.
 */
export interface BatteryReading {
    /** Whole-percent capacity, e.g. 78 for "78%". */
    capacity: number;
    /** Raw kernel status string, e.g. "Charging" / "Discharging" / "Full". */
    status: string;
    /** Estimated hours remaining when discharging; null when not estimable. */
    hoursRemaining: number | null;
}

export async function readBattery(root = powerSupplyRoot()): Promise<BatteryReading | null> {
    let entries: string[];
    try {
        entries = await readdir(root);
    } catch {
        return null;
    }
    const battery = entries.find((e) => /^BAT\d*$/i.test(e));
    if (battery === undefined) return null;

    const dir = join(root, battery);
    const readNum = async (file: string): Promise<number | null> => {
        try {
            const text = await readFile(join(dir, file), "utf8");
            const n = Number.parseFloat(text.trim());
            return Number.isFinite(n) ? n : null;
        } catch {
            return null;
        }
    };
    const readStr = async (file: string): Promise<string | null> => {
        try {
            return (await readFile(join(dir, file), "utf8")).trim();
        } catch {
            return null;
        }
    };

    const capacity = await readNum("capacity");
    if (capacity === null) return null;
    const status = (await readStr("status")) ?? "Unknown";

    // hoursRemaining is only meaningful while discharging. We try
    // `energy_now / power_now` (the kernel keeps both in microwatt-hours
    // and microwatts so the unit cancels), then fall back to `charge_now
    // / current_now`. If neither pair is present we return null and the
    // formatter omits the runtime estimate.
    let hoursRemaining: number | null = null;
    if (/^discharging$/i.test(status)) {
        const energyNow = await readNum("energy_now");
        const powerNow = await readNum("power_now");
        if (energyNow !== null && powerNow !== null && powerNow > 0) {
            hoursRemaining = energyNow / powerNow;
        } else {
            const chargeNow = await readNum("charge_now");
            const currentNow = await readNum("current_now");
            if (chargeNow !== null && currentNow !== null && currentNow > 0) {
                hoursRemaining = chargeNow / currentNow;
            }
        }
    }

    return { capacity, status, hoursRemaining };
}

export function formatBatteryReply(reading: BatteryReading): string {
    const pct = Math.round(reading.capacity);
    const s = reading.status.toLowerCase();
    if (s === "charging") return `${pct}%, charging.`;
    if (s === "full" || s === "not charging") return `${pct}%, plugged in and topped up.`;
    if (s === "discharging") {
        if (reading.hoursRemaining !== null && reading.hoursRemaining > 0) {
            const hours = reading.hoursRemaining;
            const phrase =
                hours >= 1.5
                    ? `about ${Math.round(hours)} hours at this rate`
                    : `about ${Math.round(hours * 60)} minutes at this rate`;
            return `${pct}%, discharging — ${phrase}.`;
        }
        return `${pct}%, discharging.`;
    }
    return `${pct}%, ${reading.status.toLowerCase()}.`;
}

export const BATTERY_STATUS_ACTION: Action = {
    name: "BATTERY_STATUS",
    similes: [
        "what's my battery",
        "battery level",
        "how much battery",
        "am i charged",
        "battery",
    ],
    description: "Report current battery percentage and charging state, or note AC-only when no battery is present.",

    validate: async () => true,

    handler: async (_runtime, _message, _state, _options, callback) => {
        const reading = await readBattery();
        const text =
            reading === null
                ? "I don't see a battery on this machine — looks like you're on AC power."
                : formatBatteryReply(reading);
        if (callback) await callback({ text, actions: ["BATTERY_STATUS"] });
        return { success: true, text };
    },
};

// ─── CURRENT_TIME ───────────────────────────────────────────────────────

/**
 * Pull `timezone = "..."` out of calibration.toml if the file exists.
 * Returns null when the file is missing, unreadable, or the field is
 * absent — the action falls back to the system default in that case.
 *
 * This intentionally does NOT depend on `onboarding/state.ts` so the
 * action stays usable even before onboarding lands; the parser is a
 * minimal line scanner matching the writer in `state.ts`.
 */
export async function readCalibrationTimezone(file = calibrationFile()): Promise<string | null> {
    if (!existsSync(file)) return null;
    let text: string;
    try {
        text = await readFile(file, "utf8");
    } catch {
        return null;
    }
    for (const rawLine of text.split("\n")) {
        const line = rawLine.trim();
        if (line === "" || line.startsWith("#")) continue;
        const m = /^timezone\s*=\s*"([^"]+)"\s*$/.exec(line);
        if (m !== null && m[1] !== undefined && m[1].length > 0) {
            return m[1];
        }
    }
    return null;
}

/**
 * Render `now` honoring `tz` if it's a valid IANA timezone; on any
 * formatter rejection (typo'd zone, exotic platform without ICU) fall
 * back to the host default.
 */
export function formatTimeReply(now: Date, tz: string | null): string {
    const opts: Intl.DateTimeFormatOptions = {
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
    };
    if (tz !== null) {
        try {
            const formatted = new Intl.DateTimeFormat("en-US", { ...opts, timeZone: tz }).format(now);
            return `It's ${formatted}.`;
        } catch {
            // fall through
        }
    }
    return `It's ${new Intl.DateTimeFormat("en-US", opts).format(now)}.`;
}

export const CURRENT_TIME_ACTION: Action = {
    name: "CURRENT_TIME",
    similes: [
        "what time is it",
        "what's the time",
        "what time",
        "tell me the time",
        "current time",
    ],
    description: "Report the current wall-clock time, honoring the calibrated timezone when set.",

    validate: async () => true,

    handler: async (_runtime, _message, _state, _options, callback) => {
        const tz = await readCalibrationTimezone();
        const text = formatTimeReply(new Date(), tz);
        if (callback) await callback({ text, actions: ["CURRENT_TIME"] });
        return { success: true, text };
    },
};
