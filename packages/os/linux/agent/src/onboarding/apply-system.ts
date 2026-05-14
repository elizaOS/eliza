// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * Apply the system-half of the calibration block — keyboard layout,
 * LANG locale, timezone — to the running live session.
 *
 * Invoked once per onboarding completion (from `commitCalibration` in
 * `state.ts`). The same values are re-applied on every subsequent boot
 * by the systemd unit `usbeliza-apply-calibration.service` which reads
 * the persisted `~/.eliza/calibration.toml` and shells the same
 * `localectl` / `timedatectl` commands. Keeping the apply logic here
 * means the post-onboarding "I'll set your keyboard now" promise is
 * honored immediately instead of after a reboot.
 *
 * Each shellout is best-effort: locked decision #25 says calibration
 * questions are optional, and a failure in this layer must NEVER crash
 * the agent or block the rest of the chat surface from coming up. Log
 * the failure for the journal and move on.
 *
 * The 0500 chroot hook installs `/etc/sudoers.d/usbeliza-localectl` with
 * NOPASSWD on `localectl`, `loadkeys`, and `timedatectl` for the
 * `eliza` user. Outside the live ISO (dev VM, host shell) the spawns
 * fail with "sudo: a password is required" and we silently degrade.
 */

import { spawn } from "node:child_process";

import type { CalibrationBlock } from "../persona.ts";

/** Result of trying to apply one of the three system-level fields. */
export interface ApplyResult {
    readonly field: "keyboard" | "locale" | "timezone";
    readonly applied: boolean;
    readonly message: string;
}

/**
 * Run a command capturing both streams. Resolves to exit code + stderr
 * (good enough for logging). Never rejects — even an ENOENT for sudo
 * surfaces as `{ code: -1, stderr: "..." }`.
 */
function runCommand(
    cmd: string,
    args: readonly string[],
    timeoutMs = 5_000,
): Promise<{ code: number; stderr: string }> {
    return new Promise((resolve) => {
        let settled = false;
        const child = spawn(cmd, [...args], { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        const timer = setTimeout(() => {
            if (!settled) {
                child.kill("SIGKILL");
                settled = true;
                resolve({ code: -1, stderr: `timeout after ${timeoutMs}ms` });
            }
        }, timeoutMs);
        child.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        child.on("error", (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ code: -1, stderr: String(err) });
        });
        child.on("close", (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ code: code ?? -1, stderr });
        });
    });
}

export interface ApplyOptions {
    /** Inject a fake `runCommand` for tests. */
    readonly run?: (
        cmd: string,
        args: readonly string[],
    ) => Promise<{ code: number; stderr: string }>;
    /** Skip all spawns; only log what we WOULD do. Useful for the test suite. */
    readonly dryRun?: boolean;
}

/**
 * Apply the keyboard layout. `localectl set-keymap` is the modern
 * systemd-backed path and writes /etc/vconsole.conf + adjusts the X11
 * mapping to match. On a system without localectl (BSDs, alpine) we
 * fall back to `loadkeys` which only updates the console keymap and
 * doesn't persist — better than nothing.
 */
async function applyKeyboard(layout: string, run: NonNullable<ApplyOptions["run"]>): Promise<ApplyResult> {
    const primary = await run("sudo", ["localectl", "set-keymap", layout]);
    if (primary.code === 0) {
        return { field: "keyboard", applied: true, message: `localectl set-keymap ${layout}` };
    }
    // Fallback: loadkeys (console-only, not persistent). On a live ISO
    // the systemd boot-time apply unit reruns set-keymap so persistence
    // comes from there.
    const fallback = await run("sudo", ["loadkeys", layout]);
    if (fallback.code === 0) {
        return {
            field: "keyboard",
            applied: true,
            message: `loadkeys ${layout} (localectl failed: ${primary.stderr.trim().slice(0, 120)})`,
        };
    }
    return {
        field: "keyboard",
        applied: false,
        message: `both localectl and loadkeys failed: ${primary.stderr.trim().slice(0, 120)}`,
    };
}

async function applyLocale(lang: string, run: NonNullable<ApplyOptions["run"]>): Promise<ApplyResult> {
    const res = await run("sudo", ["localectl", "set-locale", `LANG=${lang}`]);
    if (res.code === 0) {
        return { field: "locale", applied: true, message: `localectl set-locale LANG=${lang}` };
    }
    return {
        field: "locale",
        applied: false,
        message: `localectl set-locale failed: ${res.stderr.trim().slice(0, 120)}`,
    };
}

async function applyTimezone(tz: string, run: NonNullable<ApplyOptions["run"]>): Promise<ApplyResult> {
    const res = await run("sudo", ["timedatectl", "set-timezone", tz]);
    if (res.code === 0) {
        return { field: "timezone", applied: true, message: `timedatectl set-timezone ${tz}` };
    }
    return {
        field: "timezone",
        applied: false,
        message: `timedatectl set-timezone failed: ${res.stderr.trim().slice(0, 120)}`,
    };
}

/**
 * Apply all three system fields. Each runs in its own try/catch so one
 * failing (e.g. timezone typo) doesn't gate the other two. Returns the
 * full result array; the caller decides whether to log or surface to
 * chat. The default `commitCalibration` path just logs to stderr.
 *
 * Skips fields that are null/undefined/empty/default ("us" / "en_US.UTF-8" /
 * "UTC") on the theory that the defaults are already what the live ISO
 * boots into — running `localectl set-keymap us` when the keymap is
 * already `us` is a harmless no-op but spends 200ms on a slow stick.
 */
export async function applySystemCalibration(
    c: CalibrationBlock,
    options: ApplyOptions = {},
): Promise<ApplyResult[]> {
    const run = options.run ?? runCommand;
    if (options.dryRun === true) {
        const dryRun: NonNullable<ApplyOptions["run"]> = async () => ({ code: 0, stderr: "" });
        return applySystemCalibration(c, { run: dryRun });
    }
    const out: ApplyResult[] = [];
    if (typeof c.keyboardLayout === "string" && c.keyboardLayout !== "" && c.keyboardLayout !== "us") {
        try {
            out.push(await applyKeyboard(c.keyboardLayout, run));
        } catch (err) {
            out.push({
                field: "keyboard",
                applied: false,
                message: `apply threw: ${(err as Error).message}`,
            });
        }
    }
    if (typeof c.language === "string" && c.language !== "" && c.language !== "en_US.UTF-8") {
        try {
            out.push(await applyLocale(c.language, run));
        } catch (err) {
            out.push({
                field: "locale",
                applied: false,
                message: `apply threw: ${(err as Error).message}`,
            });
        }
    }
    if (typeof c.timezone === "string" && c.timezone !== "" && c.timezone !== "UTC") {
        try {
            out.push(await applyTimezone(c.timezone, run));
        } catch (err) {
            out.push({
                field: "timezone",
                applied: false,
                message: `apply threw: ${(err as Error).message}`,
            });
        }
    }
    return out;
}

/**
 * Try to detect the user's timezone from a free geo-IP API. Returns
 * `null` on any error or when the network is offline (NetworkManager
 * status fed in as the `online` flag — the caller is expected to know
 * this and skip when offline). Used by the timezone question to
 * suggest a sensible default rather than always asking blind.
 *
 * Endpoint: ipapi.co is free, no key, and ships a `timezone` field as
 * an IANA string. We give it a tight 2-second timeout so a slow API
 * doesn't stall onboarding — falling back to a generic prompt is
 * preferable to a 30-second hang.
 */
export async function suggestTimezoneFromIp(
    fetchImpl: typeof fetch = fetch,
    timeoutMs = 2_000,
): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetchImpl("https://ipapi.co/json/", { signal: controller.signal });
        if (!res.ok) return null;
        const data = (await res.json()) as { timezone?: unknown };
        const tz = data.timezone;
        if (typeof tz !== "string" || tz === "") return null;
        // Cheap sanity check — IANA strings always contain a `/` and
        // alphanumerics. Reject anything that doesn't look like one.
        if (!/^[A-Za-z]+\/[A-Za-z_\-+/0-9]+$/.test(tz)) return null;
        return tz;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}
