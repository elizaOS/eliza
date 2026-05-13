// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * INSTALL_PACKAGE — chat-driven `apt-get install`.
 *
 * The Her-style desktop ricing path. "give me a minimalist i3 desktop" /
 * "install gnome" / "set up vim" all funnel here. The action validates
 * the package name, looks it up via `apt-cache madison` to confirm it
 * exists + grab a size estimate, then KICKS OFF the install-package
 * multi-turn confirmation flow (so the actual apt-get only runs after
 * an explicit user "yes").
 *
 * Boundaries (apt-cache lookup, apt-get spawn) are injected via runtime
 * `options` so tests don't shell out to apt. Same pattern as
 * DOWNLOAD_MODEL's `SpawnStreamFn`.
 */

import type { Action, ActionExample } from "@elizaos/core";

import { beginInstallPackageFlow } from "../flows/install-package-flow.ts";
import {
    type AptCacheFn,
    type SpawnStreamFn,
    DEFAULT_APT_CACHE,
} from "../flows/install-package-runner.ts";

/**
 * Package-name validation. Debian policy: lowercase, digits, plus, dash,
 * dot, underscore; must start with alphanumeric; 2-64 chars. Anything
 * outside this charset is rejected outright so shell metacharacters can
 * never reach `apt-get`.
 */
export const PACKAGE_NAME_RE = /^[a-z0-9][a-z0-9.+\-_]{1,63}$/;

/**
 * Foot-gun packages we refuse to install from chat — installing any of
 * these breaks the live chroot (sudo / sshd / cron daemons that fight
 * with our minimal init). Override with USBELIZA_ALLOW_DANGEROUS_PACKAGES=1.
 */
export const DANGEROUS_PACKAGES = new Set([
    "openssh-server",
    "sudo",
    "systemd-cron",
    "rsyslog",
]);

/**
 * Hand-curated "give me X" → [pkg, ...] mappings. Users say "i3 desktop"
 * meaning "i3 + a status bar + a launcher + a terminal"; this table
 * makes those one-liners just work. Keys are lowercase phrases checked
 * by substring.
 */
export const PACKAGE_GROUPS: ReadonlyArray<{ readonly phrase: string; readonly packages: readonly string[] }> = [
    { phrase: "i3 desktop", packages: ["i3", "i3status", "i3lock", "dmenu", "xterm"] },
    { phrase: "i3 setup", packages: ["i3", "i3status", "i3lock", "dmenu", "xterm"] },
    { phrase: "minimalist i3", packages: ["i3", "i3status", "i3lock", "dmenu", "xterm"] },
    { phrase: "sway desktop", packages: ["sway", "swaybg", "swayidle", "swaylock", "foot", "wofi"] },
    { phrase: "gnome desktop", packages: ["gnome-shell", "gnome-terminal", "nautilus", "gnome-control-center"] },
    { phrase: "kde desktop", packages: ["plasma-desktop", "konsole", "dolphin"] },
    { phrase: "xfce desktop", packages: ["xfce4", "xfce4-terminal"] },
    { phrase: "vim setup", packages: ["vim", "vim-airline", "vim-fugitive"] },
    { phrase: "dev essentials", packages: ["build-essential", "git", "curl", "ripgrep", "fd-find"] },
    { phrase: "developer essentials", packages: ["build-essential", "git", "curl", "ripgrep", "fd-find"] },
    { phrase: "developer tools", packages: ["build-essential", "git", "curl", "ripgrep", "fd-find"] },
];

/**
 * Verbs that signal install intent + a candidate package follows. Order
 * matters — longer patterns first so "apt install" wins over "install".
 */
const INSTALL_VERBS: readonly RegExp[] = [
    /\bapt\s+install\s+(.+)$/i,
    /\bapt-get\s+install\s+(.+)$/i,
    /\binstall\s+(.+)$/i,
    /\bset\s+up\s+(.+)$/i,
    /\bgive\s+me\s+(.+)$/i,
    /\bi\s+want\s+(.+)$/i,
    /\badd\s+package\s+(.+)$/i,
    /\badd\s+(.+)$/i,
];

/**
 * Sentinel words that, on their own, mean the user is venting rather
 * than asking for a package — "install vibes", "install good energy"
 * etc. Reject these so validate() doesn't blindly send "vibes" to apt.
 */
const NON_PACKAGE_TAILS = new Set([
    "vibes",
    "energy",
    "confidence",
    "hope",
    "love",
    "joy",
    "courage",
    "yourself",
    "myself",
    "it",
    "that",
    "this",
]);

export interface ExtractResult {
    readonly packages: readonly string[];
    /** True when the phrase matched a curated group ("i3 desktop" → 5 pkgs). */
    readonly fromGroup: boolean;
    /** Original phrase the user said after the verb, for error messages. */
    readonly rawTail: string;
}

/**
 * Pull a package list out of user text. Tries:
 *
 *   1. Hand-curated group phrases ("i3 desktop", "dev essentials") that
 *      expand to 3–6 packages.
 *   2. Verb + tail extraction — split the tail on whitespace, keep
 *      tokens that look like package names.
 *
 * Returns `null` when nothing valid can be extracted (i.e., the user
 * said "install vibes" or "install ; rm -rf /").
 */
export function extractPackages(text: string): ExtractResult | null {
    const lowered = text.trim().toLowerCase();
    if (lowered === "") return null;

    for (const group of PACKAGE_GROUPS) {
        if (lowered.includes(group.phrase)) {
            return {
                packages: [...group.packages],
                fromGroup: true,
                rawTail: group.phrase,
            };
        }
    }

    let tail: string | null = null;
    for (const re of INSTALL_VERBS) {
        const m = re.exec(lowered);
        if (m !== null && m[1] !== undefined) {
            tail = m[1].trim();
            break;
        }
    }
    if (tail === null || tail === "") return null;

    // If the tail contains any shell metacharacter the user is clearly
    // not naming a package — reject outright rather than try to salvage
    // a token. (Belt-and-braces; spawn args are passed as an array so
    // the shell never sees them, but this keeps a clear "unparseable
    // input" surface.)
    if (/[;&|<>$`(){}\\]/.test(tail) || tail.includes("..")) {
        return null;
    }

    // Strip trailing filler ("install vim please", "set up vim for me").
    const trailingFillers = ["please", "for me", "now", "thanks", "thank you"];
    for (const f of trailingFillers) {
        if (tail.endsWith(" " + f)) tail = tail.slice(0, -(f.length + 1));
        else if (tail === f) return null;
    }

    const tokens = tail.split(/[\s,]+/).filter((t) => t.length > 0);
    if (tokens.length === 0) return null;

    if (tokens.length === 1 && tokens[0] !== undefined && NON_PACKAGE_TAILS.has(tokens[0])) {
        return null;
    }

    const valid: string[] = [];
    for (const tok of tokens) {
        if (PACKAGE_NAME_RE.test(tok)) {
            valid.push(tok);
        }
    }
    if (valid.length === 0) return null;
    return { packages: valid, fromGroup: false, rawTail: tail };
}

export function isDangerous(pkg: string): boolean {
    if (process.env.USBELIZA_ALLOW_DANGEROUS_PACKAGES === "1") return false;
    return DANGEROUS_PACKAGES.has(pkg);
}

/**
 * Returns true when the user clearly intends a package install. The
 * validator wins ONLY when extractPackages() finds at least one valid
 * package name — "install vibes" falls through to chat.
 */
export function hasInstallIntent(text: string): boolean {
    const lowered = text.trim().toLowerCase();
    if (lowered === "") return false;
    let verbHit = false;
    for (const re of INSTALL_VERBS) {
        if (re.test(lowered)) {
            verbHit = true;
            break;
        }
    }
    if (!verbHit) return false;
    return extractPackages(text) !== null;
}

interface InstallRuntimeOptions {
    aptCacheFn?: AptCacheFn;
    spawnFn?: SpawnStreamFn;
}

function readOptions(options: unknown): InstallRuntimeOptions {
    if (typeof options !== "object" || options === null) return {};
    const o = options as Record<string, unknown>;
    const out: InstallRuntimeOptions = {};
    if (typeof o.aptCacheFn === "function") out.aptCacheFn = o.aptCacheFn as AptCacheFn;
    if (typeof o.spawnFn === "function") out.spawnFn = o.spawnFn as SpawnStreamFn;
    return out;
}

const EXAMPLES: ActionExample[][] = [
    [
        { name: "{{user}}", content: { text: "install vim" } },
        {
            name: "Eliza",
            content: {
                text: "I can install vim (~5 MB). Want to proceed? yes / no",
            },
        },
    ],
    [
        { name: "{{user}}", content: { text: "give me a minimalist i3 desktop" } },
        {
            name: "Eliza",
            content: {
                text: "I can install i3, i3status, i3lock, dmenu, and xterm (~12 MB total). Proceed? yes / no",
            },
        },
    ],
    [
        { name: "{{user}}", content: { text: "apt install ripgrep" } },
        {
            name: "Eliza",
            content: {
                text: "I can install ripgrep (~2 MB). Want to proceed? yes / no",
            },
        },
    ],
];

export const INSTALL_PACKAGE_ACTION: Action = {
    name: "INSTALL_PACKAGE",
    similes: [
        "install",
        "install package",
        "install vim",
        "install gnome",
        "install i3",
        "apt install",
        "apt-get install",
        "set up package",
        "set up vim",
        "set up i3",
        "give me a desktop",
        "give me i3",
        "give me gnome",
        "i want package",
        "add package",
    ],
    description:
        "Install a Debian package via apt-get with confirmation. Used when the user says " +
        "'install vim', 'apt install ripgrep', 'give me a minimalist i3 desktop', 'set up sway', etc.",

    validate: async (_runtime, message) => {
        const text = typeof message.content?.text === "string" ? message.content.text : "";
        return hasInstallIntent(text);
    },

    handler: async (_runtime, message, _state, options, callback) => {
        const text = typeof message.content?.text === "string" ? message.content.text : "";
        const opts = readOptions(options);
        const aptCache = opts.aptCacheFn ?? DEFAULT_APT_CACHE;

        const extracted = extractPackages(text);
        if (extracted === null) {
            const reply =
                "I'd need a package name — try 'install vim' or 'give me a minimalist i3 desktop'.";
            if (callback) await callback({ text: reply, actions: ["INSTALL_PACKAGE"] });
            return { success: false, text: reply };
        }

        const blocked = extracted.packages.filter(isDangerous);
        if (blocked.length > 0) {
            const reply =
                `I can't install ${blocked.join(", ")} — it'd break the chroot. ` +
                "(If you really need it, run apt-get from a terminal.)";
            if (callback) await callback({ text: reply, actions: ["INSTALL_PACKAGE"] });
            return { success: false, text: reply };
        }

        const missing: string[] = [];
        let totalKb = 0;
        for (const pkg of extracted.packages) {
            try {
                const info = await aptCache(pkg);
                if (info === null) {
                    missing.push(pkg);
                } else {
                    totalKb += info.sizeKb;
                }
            } catch {
                missing.push(pkg);
            }
        }
        if (missing.length === extracted.packages.length) {
            const reply =
                `I can't find ${missing.join(", ")} in apt. ` +
                "Check the spelling, or update the package index with 'apt update' from a terminal.";
            if (callback) await callback({ text: reply, actions: ["INSTALL_PACKAGE"] });
            return { success: false, text: reply };
        }

        const installable = extracted.packages.filter((p) => !missing.includes(p));
        const sizeMb = Math.max(1, Math.round(totalKb / 1024));
        const flowReply = await beginInstallPackageFlow({
            packages: installable,
            sizeMb,
            ...(opts.spawnFn !== undefined ? { spawnFn: opts.spawnFn } : {}),
        });
        if (callback) await callback({ text: flowReply.reply, actions: ["INSTALL_PACKAGE"] });
        return {
            success: true,
            text: flowReply.reply,
            data: { actionName: "INSTALL_PACKAGE", packages: installable, sizeMb },
        };
    },

    examples: EXAMPLES,
};
