// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * Persistent onboarding state.
 *
 * The chat handler is stateless per /api/chat request, so we keep the
 * progress through the calibration questions on disk under
 * `~/.eliza/onboarding.toml`. Each turn loads the partial calibration,
 * advances by one question, and writes the new state back atomically.
 *
 * State shape:
 *   - `answers`: partial fields of `CalibrationBlock` populated so far
 *   - `nextQuestionIndex`: position in `QUESTIONS`; equal to QUESTIONS.length
 *     means onboarding is complete
 *   - `lastClarifyAttempts`: per-question count of clarifying re-asks
 *     before we give up and accept a freeform answer (caps at 2)
 *
 * Once `nextQuestionIndex === QUESTIONS.length`, the dispatcher writes
 * the final `~/.eliza/calibration.toml` and deletes the onboarding state
 * file so the chat handler resumes normal intent dispatch.
 *
 * Path resolution mirrors the Rust calibration_store (USBELIZA_STATE_DIR
 * → ~/.eliza/) so the live ISO's encrypted-persistence partition picks
 * this up via the same `/home/eliza/.eliza` bind-mount.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { CalibrationBlock } from "../persona.ts";
import { applySystemCalibration } from "./apply-system.ts";
import { QUESTIONS } from "./questions.ts";

export interface OnboardingState {
    readonly schema_version: 1;
    readonly answers: Partial<CalibrationBlock>;
    readonly nextQuestionIndex: number;
    /** Per-question clarify-attempt counter (caps at 2). */
    readonly clarifyAttempts: Record<string, number>;
}

export interface ResolvedPaths {
    readonly stateFile: string;
    readonly calibrationFile: string;
}

function stateRoot(): string {
    const explicit = process.env.USBELIZA_STATE_DIR;
    if (explicit !== undefined && explicit !== "") return explicit;
    return join(homedir(), ".eliza");
}

export function resolvePaths(): ResolvedPaths {
    const root = stateRoot();
    return {
        stateFile: join(root, "onboarding.toml"),
        calibrationFile: join(root, "calibration.toml"),
    };
}

/**
 * Initial state — no answers, pointing at the first question.
 */
export function freshState(): OnboardingState {
    return { schema_version: 1, answers: {}, nextQuestionIndex: 0, clarifyAttempts: {} };
}

/**
 * Returns `null` when onboarding is complete (calibration.toml exists),
 * a fresh state when neither file exists, or the saved state when
 * onboarding is mid-flight.
 *
 * The "calibration exists" branch takes precedence: it means a prior
 * session finished onboarding and the user is now in normal chat mode.
 */
export function loadState(): OnboardingState | null {
    const { stateFile, calibrationFile } = resolvePaths();
    if (existsSync(calibrationFile)) return null;
    if (!existsSync(stateFile)) return freshState();
    const text = readFileSync(stateFile, "utf8");
    return parseTomlState(text);
}

/**
 * Persist state atomically (write-and-rename so a crash mid-write
 * doesn't leave a half-written toml that fails to parse on next boot).
 */
export function saveState(state: OnboardingState): void {
    const { stateFile } = resolvePaths();
    const dir = dirname(stateFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${stateFile}.tmp.${process.pid}`;
    writeFileSync(tmp, serializeTomlState(state));
    // node:fs has no atomic-rename; Bun's rename is atomic on POSIX.
    // We use sync rename via a tiny shellout-free call:
    require("node:fs").renameSync(tmp, stateFile);
}

/**
 * Called once when the last question is answered. Writes a full
 * calibration.toml and deletes the onboarding state file. Mirrors the
 * Rust calibration_store schema so the existing reader picks it up
 * without code changes.
 *
 * The Rust schema includes `schema_version` and `created_at` which we
 * inject here. Bumping CalibrationProfile in eliza_types requires also
 * bumping this serializer.
 */
export function commitCalibration(block: CalibrationBlock): void {
    const { stateFile, calibrationFile } = resolvePaths();
    const dir = dirname(calibrationFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const text = serializeCalibrationToml(block);
    const tmp = `${calibrationFile}.tmp.${process.pid}`;
    writeFileSync(tmp, text);
    require("node:fs").renameSync(tmp, calibrationFile);
    if (existsSync(stateFile)) unlinkSync(stateFile);

    // Fire-and-forget: apply keyboard / locale / timezone to the live
    // session. Each spawn is best-effort and logs to stderr on failure
    // (see apply-system.ts for the rationale). We don't await — the
    // chat reply that triggered this commit shouldn't pay the cost of
    // a localectl shellout, and the system unit re-applies on every
    // boot anyway. Suppressed in test environments where the
    // calibration file is written under a tempdir.
    if (process.env.USBELIZA_SKIP_APPLY === "1" || process.env.USBELIZA_STATE_DIR !== undefined) {
        return;
    }
    applySystemCalibration(block).then(
        (results) => {
            for (const r of results) {
                if (!r.applied) {
                    process.stderr.write(`[usbeliza] apply ${r.field}: ${r.message}\n`);
                }
            }
        },
        (err) => {
            process.stderr.write(`[usbeliza] applySystemCalibration threw: ${(err as Error).message}\n`);
        },
    );
}

/**
 * For tests: scrub both state and calibration files. Production code
 * never calls this; it exists so test fixtures can reset cleanly.
 */
export function resetForTest(): void {
    const { stateFile, calibrationFile } = resolvePaths();
    if (existsSync(stateFile)) unlinkSync(stateFile);
    if (existsSync(calibrationFile)) unlinkSync(calibrationFile);
}

/** True when there's no calibration.toml yet — the chat handler should run the onboarding flow. */
export function isOnboardingActive(): boolean {
    const { calibrationFile } = resolvePaths();
    return !existsSync(calibrationFile);
}

// ─── TOML serialization (minimal — we don't want a full toml dep here) ────

function serializeTomlState(state: OnboardingState): string {
    const lines = [
        `schema_version = ${state.schema_version}`,
        `next_question_index = ${state.nextQuestionIndex}`,
        "",
        "[answers]",
    ];
    for (const q of QUESTIONS) {
        const v = state.answers[q.id];
        if (v !== undefined) lines.push(`${q.id} = ${JSON.stringify(v)}`);
    }
    lines.push("", "[clarify_attempts]");
    for (const [k, v] of Object.entries(state.clarifyAttempts)) {
        lines.push(`${k} = ${v}`);
    }
    return lines.join("\n") + "\n";
}

function parseTomlState(text: string): OnboardingState {
    const answers: Partial<CalibrationBlock> = {};
    const clarifyAttempts: Record<string, number> = {};
    let nextQuestionIndex = 0;
    let section: "root" | "answers" | "clarify" = "root";
    for (const rawLine of text.split("\n")) {
        const line = rawLine.trim();
        if (line === "" || line.startsWith("#")) continue;
        if (line === "[answers]") {
            section = "answers";
            continue;
        }
        if (line === "[clarify_attempts]") {
            section = "clarify";
            continue;
        }
        const m = /^([A-Za-z_][\w]*)\s*=\s*(.+)$/.exec(line);
        if (m === null || m[1] === undefined || m[2] === undefined) continue;
        const key = m[1];
        const raw = m[2].trim();
        if (section === "root") {
            if (key === "next_question_index") {
                const n = parseInt(raw, 10);
                if (!Number.isNaN(n)) nextQuestionIndex = n;
            }
            continue;
        }
        if (section === "answers") {
            // Coerce TOML scalar types: quoted strings via JSON.parse,
            // bare `true` / `false` to real booleans, bare integers to
            // numbers. Anything else falls through as a raw string so
            // legacy state files with unquoted text round-trip.
            //
            // Without the bool/number branches, an unquoted `true`
            // round-trips as the string "true" — which then gets
            // re-serialized as `"true"` (quoted) and dropped from the
            // final calibration.toml by the `typeof === "boolean"`
            // guard in serializeCalibrationToml.
            let value: unknown;
            if (raw.startsWith('"')) {
                value = JSON.parse(raw);
            } else if (raw === "true") {
                value = true;
            } else if (raw === "false") {
                value = false;
            } else if (/^-?\d+$/.test(raw)) {
                value = parseInt(raw, 10);
            } else {
                value = raw;
            }
            // The on-disk key uses snake_case (toml convention) but
            // CalibrationBlock fields are camelCase; do the small
            // remap here so older onboarding.toml files with snake
            // keys still round-trip through this loader.
            const camelKey =
                key === "keyboard_layout"
                    ? "keyboardLayout"
                    : key === "error_communication"
                      ? "errorCommunication"
                      : key === "work_focus"
                        ? "workFocus"
                        : key;
            (answers as Record<string, unknown>)[camelKey] = value;
            continue;
        }
        if (section === "clarify") {
            const n = parseInt(raw, 10);
            if (!Number.isNaN(n)) clarifyAttempts[key] = n;
        }
    }
    return { schema_version: 1, answers, nextQuestionIndex, clarifyAttempts };
}

function serializeCalibrationToml(c: CalibrationBlock): string {
    const created = new Date().toISOString();
    const lines = [
        `schema_version = 1`,
        `created_at = "${created}"`,
        `name = ${JSON.stringify(c.name)}`,
        `work_focus = ${JSON.stringify(c.workFocus)}`,
        `multitasking = "${c.multitasking}"`,
        `chronotype = "${c.chronotype}"`,
        `error_communication = "${c.errorCommunication}"`,
    ];
    // System fields are optional — only emit them when set so calibration
    // files written by an older agent (5 fields) and a newer agent (8
    // fields) both parse cleanly against the same toml grammar.
    if (typeof c.keyboardLayout === "string" && c.keyboardLayout !== "") {
        lines.push(`keyboard_layout = ${JSON.stringify(c.keyboardLayout)}`);
    }
    if (typeof c.language === "string" && c.language !== "") {
        lines.push(`language = ${JSON.stringify(c.language)}`);
    }
    if (typeof c.timezone === "string" && c.timezone !== "") {
        lines.push(`timezone = ${JSON.stringify(c.timezone)}`);
    }
    // Offer flags: persist so a reboot doesn't re-prompt for Wi-Fi or
    // Claude/Codex login after the user already answered Q2 / Q3. The
    // SSID + auth tokens themselves live elsewhere (NetworkManager,
    // ~/.eliza/auth/) — these booleans only record "we asked".
    if (typeof c.wifiOfferAccepted === "boolean") {
        lines.push(`wifi_offer_accepted = ${String(c.wifiOfferAccepted)}`);
    }
    if (typeof c.claudeOfferAccepted === "boolean") {
        lines.push(`claude_offer_accepted = ${String(c.claudeOfferAccepted)}`);
    }
    return lines.join("\n") + "\n";
}
