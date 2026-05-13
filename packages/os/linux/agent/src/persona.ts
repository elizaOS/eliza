// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * Persona loader.
 *
 * Source of truth: `characters/eliza.ts` — a validated `@elizaos/agent`
 * `Character` carrying the persona base + OS-context preamble. This file's
 * job is *only* to compose the runtime system prompt by appending the
 * dynamic `<calibration>` block read from `~/.eliza/calibration.toml`.
 *
 * Keeping the static character separate from the per-user calibration
 * means we can swap one without disturbing the other, and the on-disk
 * calibration file stays the single user-state surface.
 */

import { ELIZA } from "./characters/eliza.ts";

export interface CalibrationBlock {
    /** Free-text from question 1: what should I call you? */
    name: string;
    /** Free-text from question 2: what do you spend most of your computer time on? */
    workFocus: string;
    /** Question 3: lots of tools at once, or just the one you need right now? */
    multitasking: "single-task" | "multi-task";
    /** Question 4: morning or evening person? */
    chronotype: "morning" | "evening" | "flexible";
    /** Question 5: when something I build doesn't work, fix quietly or tell you? */
    errorCommunication: "transparent" | "quiet";
    /**
     * Question 6 (system): X11/console keymap, e.g. "us", "uk", "de", "dvorak".
     * Applied via `localectl set-keymap` (or `loadkeys` fallback) every boot.
     * Optional/nullable so calibration.toml files written before the system
     * questions landed still parse cleanly.
     */
    keyboardLayout?: string | null;
    /**
     * Question 7 (system): LANG locale string, e.g. "en_US.UTF-8", "es_ES.UTF-8".
     * Applied via `localectl set-locale LANG=...` every boot.
     */
    language?: string | null;
    /**
     * Question 8 (system): IANA timezone string, e.g. "UTC", "America/Los_Angeles".
     * Applied via `timedatectl set-timezone` every boot.
     */
    timezone?: string | null;
    /**
     * Whether Eliza offered to set up Wi-Fi at onboarding-question-2 and the
     * user accepted. The actual SSID + password are NOT stored here — the
     * multi-turn wifi-flow saves them to NetworkManager via nmcli. This
     * field exists only to record "did we already ask" so a reboot doesn't
     * re-prompt. Locked decision: wifi offer comes RIGHT AFTER the name
     * question so the user can use a real Claude model from turn 3 onward.
     */
    wifiOfferAccepted?: boolean | null;
    /**
     * Same shape, for the Claude / Codex auth offer at onboarding-question-3.
     * The actual token lands at `~/.eliza/auth/{claude,codex}.json` via the
     * LOGIN_CLAUDE / LOGIN_CODEX OAuth loop.
     */
    claudeOfferAccepted?: boolean | null;
}

/**
 * Compose the full system prompt prefix.
 *
 * Used by milestone 11b's runtime boot to seed `runtime.character.system`
 * dynamically per-user.
 *
 * @param calibration - Optional calibration block. Absent before first boot completes.
 */
export function buildSystemPrompt(
    calibration: CalibrationBlock | null,
): string {
    const sections: string[] = [];
    if (typeof ELIZA.system === "string" && ELIZA.system.length > 0) {
        sections.push(ELIZA.system);
    }
    if (calibration !== null) {
        sections.push(formatCalibration(calibration));
    }
    return sections.join("\n\n");
}

function formatCalibration(c: CalibrationBlock): string {
    const lines = [
        "<calibration>",
        `  name: ${c.name}`,
        `  work_focus: ${c.workFocus}`,
        `  multitasking: ${c.multitasking}`,
        `  chronotype: ${c.chronotype}`,
        `  error_communication: ${c.errorCommunication}`,
    ];
    // System fields are optional — only render them when non-null/non-empty
    // so older calibration.toml files (5 fields) and newer ones (8 fields)
    // both serialize cleanly without leaking "null" into the prompt.
    if (typeof c.keyboardLayout === "string" && c.keyboardLayout !== "") {
        lines.push(`  keyboard_layout: ${c.keyboardLayout}`);
    }
    if (typeof c.language === "string" && c.language !== "") {
        lines.push(`  language: ${c.language}`);
    }
    if (typeof c.timezone === "string" && c.timezone !== "") {
        lines.push(`  timezone: ${c.timezone}`);
    }
    lines.push("</calibration>");
    return lines.join("\n");
}
