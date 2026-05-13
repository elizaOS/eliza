// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * SET_WALLPAPER — Eliza generates a wallpaper image from a natural-language
 * brief and tells sway to use it as the desktop background.
 *
 * Two generation paths (cheapest first):
 *
 *   1. **ImageMagick procedural** — the default offline path. Parses a
 *      handful of keywords from the user's brief (color words, "stars",
 *      "gradient", "noise", "dark", "light") and assembles an ImageMagick
 *      command. Always works without network.
 *
 *   2. **Claude SVG** — when claude is signed in, we ask it to produce
 *      a self-contained SVG matching the brief, then rasterize to PNG.
 *      Much more interesting wallpapers but needs the user to be logged
 *      in. Skipped in v10 to keep this commit focused; the hook is here.
 *
 * The rendered PNG lands at `~/.eliza/wallpapers/<slug>.png` (so the
 * chat-driven app lifecycle's atomic-swap pattern applies — wallpapers
 * accumulate, the user can ask "go back to the space one" later).
 *
 * Setting the wallpaper is `swaymsg "output * bg <path> fill"` — sway
 * reloads it instantly without restarting the compositor.
 */

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Action, IAgentRuntime, Memory } from "@elizaos/core";

import { slugify } from "../match.ts";

const WALLPAPERS_DIR = (() => {
    const explicit = Bun.env.USBELIZA_WALLPAPERS_DIR;
    if (explicit !== undefined && explicit !== "") return explicit;
    const home = Bun.env.HOME ?? "/tmp";
    return join(home, ".eliza/wallpapers");
})();

interface PaletteSpec {
    /** Hex color sky/background. */
    background: string;
    /** Hex color foreground/highlights. */
    foreground: string;
    /** "dark" or "light" — picks contrast direction for accent details. */
    mood: "dark" | "light";
}

/**
 * Parse the user's brief into a PaletteSpec. Recognized keywords cover
 * the most common color words + a few moods. Defaults to ElizaOS's own
 * orange-on-black palette when nothing matches.
 */
function paletteFromBrief(brief: string): PaletteSpec {
    const lower = brief.toLowerCase();
    // Mood (dark default — matches ElizaOS palette)
    const mood: "dark" | "light" = /\b(light|bright|pastel|white)\b/.test(lower)
        ? "light"
        : "dark";
    const bgDark = "#0a0a0a";
    const bgLight = "#f5f3ef";
    let background = mood === "dark" ? bgDark : bgLight;
    let foreground = mood === "dark" ? "#FF6B35" : "#1a1a1a";
    // Specific color overrides
    if (/\b(space|night|midnight|cosmic|stars)\b/.test(lower)) {
        background = "#03001a";
        foreground = "#ffffff";
    } else if (/\b(sunset|warm|amber|orange)\b/.test(lower)) {
        background = "#1a0a02";
        foreground = "#FF6B35";
    } else if (/\b(ocean|sea|blue|navy|deep)\b/.test(lower)) {
        background = "#031a2a";
        foreground = "#5dabd1";
    } else if (/\b(forest|emerald|green|moss)\b/.test(lower)) {
        background = "#0a1a0a";
        foreground = "#7fbf7f";
    } else if (/\b(rose|pink|magenta|cherry)\b/.test(lower)) {
        background = "#2a0316";
        foreground = "#e85a85";
    } else if (/\b(purple|violet|plum)\b/.test(lower)) {
        background = "#1a0a2a";
        foreground = "#b07dd1";
    }
    return { background, foreground, mood };
}

/**
 * Compose an ImageMagick `convert` command that paints a 1920x1080
 * wallpaper from the brief. We accumulate a base solid + a foreground
 * detail layer keyed off recognized motif words (stars, gradient,
 * noise, geometric, lines).
 */
function imagemagickArgs(brief: string, palette: PaletteSpec, outPath: string): string[] {
    const lower = brief.toLowerCase();
    const args: string[] = ["-size", "1920x1080"];
    // Base canvas
    args.push(`xc:${palette.background}`);

    // Gradient overlay
    if (/\bgradient\b/.test(lower)) {
        args.push(
            "(",
            "-size",
            "1920x1080",
            `gradient:${palette.background}-${darken(palette.background)}`,
            ")",
            "-compose",
            "blend",
            "-define",
            "compose:args=70,30",
            "-composite",
        );
    }

    // Stars / noise — randomly place small dots of foreground
    if (/\b(stars?|sparkles?|noise|grain|dots?)\b/.test(lower)) {
        // Use plasma + threshold to make pseudo-random dots, then composite
        args.push(
            "(",
            "-size",
            "1920x1080",
            "plasma:fractal",
            "-channel",
            "RGB",
            "-threshold",
            "98%",
            "-blur",
            "0x0.5",
            "-fill",
            palette.foreground,
            "-opaque",
            "white",
            "-transparent",
            "black",
            ")",
            "-compose",
            "over",
            "-composite",
        );
    }

    // Centered Eliza wordmark — only when explicitly requested ("with eliza" / "with my name")
    if (/\b(eliza|her name|wordmark|signature)\b/.test(lower)) {
        args.push(
            "-gravity",
            "center",
            "-font",
            "DejaVu-Sans",
            "-pointsize",
            "180",
            "-fill",
            palette.foreground,
            "-annotate",
            "0",
            "Eliza",
        );
    }

    args.push(outPath);
    return args;
}

function darken(hex: string): string {
    // Cheap dim: clamp each channel to 70% of value
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (m === null) return hex;
    const [r, g, b] = [m[1], m[2], m[3]].map((c) =>
        Math.round(Number.parseInt(c ?? "0", 16) * 0.55)
            .toString(16)
            .padStart(2, "0"),
    );
    return `#${r}${g}${b}`;
}

async function generateWallpaper(brief: string, slug: string): Promise<string> {
    const palette = paletteFromBrief(brief);
    const outPath = join(WALLPAPERS_DIR, `${slug}.png`);
    await mkdir(dirname(outPath), { recursive: true });
    const args = imagemagickArgs(brief, palette, outPath);
    await new Promise<void>((resolve, reject) => {
        const child = spawn("convert", args, { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        child.on("error", (err) =>
            reject(new Error(`ImageMagick spawn failed: ${err.message}`)),
        );
        child.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`ImageMagick exited ${code}: ${stderr.slice(0, 400)}`));
        });
    });
    return outPath;
}

async function applyWallpaperViaSway(path: string): Promise<void> {
    // Skip in test mode — there's no sway socket and the chroot test
    // suite doesn't have a compositor to drive.
    if (process.env.USBELIZA_STATE_DIR !== undefined) return;
    await new Promise<void>((resolve, reject) => {
        const child = spawn("swaymsg", ["output", "*", "bg", path, "fill"], {
            stdio: "ignore",
        });
        child.on("error", (err) =>
            reject(new Error(`swaymsg spawn failed: ${err.message}`)),
        );
        child.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`swaymsg exited ${code}`));
        });
    });
}

function briefFromMessage(text: string): string | null {
    const lower = text.toLowerCase().trim();
    const verbs = [
        /^(make|set|create|build|generate|paint|put)\b/,
        /\b(my )?wallpaper\b/,
        /\b(my )?background\b/,
        /\b(my )?desktop\b/,
    ];
    if (!verbs.some((re) => re.test(lower))) return null;
    // Strip the verb + filler so the brief is just the descriptive part.
    const cleaned = lower
        .replace(/^(please\s+)?/, "")
        .replace(/^(make|set|create|build|generate|paint|put)\s+(me\s+)?(a|an|my|the)?\s*/, "")
        .replace(/(my )?(wallpaper|background|desktop)\s*(to|with|that's|that is)?\s*/, "")
        .trim();
    return cleaned.length > 0 ? cleaned : "default";
}

export const SET_WALLPAPER_ACTION: Action = {
    name: "SET_WALLPAPER",
    similes: [
        "set my wallpaper",
        "make me a wallpaper",
        "change my wallpaper",
        "set the wallpaper",
        "set my background",
        "change my background",
        "change my desktop",
        "paint my desktop",
        "make my desktop",
    ],
    description:
        "Generate a wallpaper image from a natural-language brief and set it " +
        "as the sway desktop background. Honors color words (space, sunset, " +
        "ocean, forest, rose, purple) and motifs (stars, gradient, noise).",

    validate: async (_runtime: IAgentRuntime, message: Memory) => {
        const text = typeof message.content?.text === "string" ? message.content.text : "";
        return briefFromMessage(text) !== null;
    },

    handler: async (_runtime, message, _state, _options, callback) => {
        const text = typeof message.content?.text === "string" ? message.content.text : "";
        const brief = briefFromMessage(text) ?? "default";
        const slug = slugify(brief).slice(0, 32) || "untitled";

        try {
            const path = await generateWallpaper(brief, slug);
            try {
                await applyWallpaperViaSway(path);
            } catch (err) {
                // Generation succeeded but apply failed — still report progress.
                const reply = `I made the wallpaper but couldn't switch sway over to it: ${(err as Error).message}. The file is at ${path}; you can swaymsg yourself.`;
                if (callback) await callback({ text: reply, actions: ["SET_WALLPAPER"] });
                return { success: false, text: reply };
            }
            const reply = `Done. New wallpaper based on "${brief}" — say "go back to the last one" if it doesn't feel right.`;
            if (callback) await callback({ text: reply, actions: ["SET_WALLPAPER"] });
            return {
                success: true,
                text: reply,
                data: { actionName: "SET_WALLPAPER", path, brief, slug },
            };
        } catch (err) {
            const reply = `I couldn't paint that wallpaper: ${(err as Error).message}. Want to try a different description?`;
            if (callback) await callback({ text: reply, actions: ["SET_WALLPAPER"] });
            return { success: false, text: reply };
        }
    },

    examples: [
        [
            { name: "{{user}}", content: { text: "make me a space wallpaper with stars" } },
            { name: "Eliza", content: { text: "Done. New wallpaper based on \"space with stars\"." } },
        ],
        [
            { name: "{{user}}", content: { text: "change my background to a sunset gradient" } },
            { name: "Eliza", content: { text: "Done. New wallpaper based on \"sunset gradient\"." } },
        ],
    ],
};
