// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * Generation-brief prompt builder.
 *
 * The system prompt (passed via `claude --system-prompt`) tells the LLM how
 * to behave — what it's building, what's allowed, what shape to output.
 * The user prompt (the second positional arg to `claude`) carries the
 * specific intent and any prior `src/` for an in-place rebuild.
 */

import type { CalibrationBlock } from "../../persona.ts";

export interface BriefInput {
    /** Stable URL-safe slug; the directory name under ~/.eliza/apps/. */
    slug: string;
    /** Free-text user intent that triggered this generation. */
    intent: string;
    /** Prior version of `<slug>/src/` for rebuild flows. Absent on first build. */
    existingSrc?: Record<string, string>;
    /** User calibration — flavor knobs, not technical constraints. */
    calibration: CalibrationBlock | null;
    /** RFC 3339 timestamp to embed in the manifest's `last_built_at`. */
    now: string;
    /** Identifier of the generation backend (e.g., `claude-code-2.1.138`). */
    builderId: string;
    /** Optional critique appended after a previous attempt's failure. */
    critique?: string;
}

const SYSTEM_PROMPT_BASE = `\
You are the code generator for ElizaOS USB. The user is asking you to build a
small, single-file app that runs inside a bubblewrap sandbox on a Linux desktop.
Your output is JSON only — do not include any prose around it.

Hard constraints:
- The app runs in a Chromium webview window opened from a local file. No network
  access unless the manifest explicitly declares the network:fetch capability.
- The app interacts with the host ONLY via the cap-bus on the Unix socket at
  /run/eliza/cap-<slug>.sock. Calls outside the declared capability set fail.
- Each capability the app uses MUST be declared in the manifest's capabilities
  array. Undeclared capabilities are rejected by the sandbox.
- For a calendar / clock / notes / editor / calculator: time:read and
  storage:scoped are usually enough. Don't request more than you'll use.
- The entry file path in the manifest MUST exist in the files map.
- The slug in the manifest MUST match the user's slug exactly.
- The manifest's schema_version is always 1. The version field is always 1
  on first build (the host bumps it on rebuilds).
- All HTML must be self-contained: inline CSS and JS, no external <link> or
  <script src>, no fonts loaded from CDNs.
- Modern dark theme by default — pure black #0a0a0a background, ElizaOS warm
  orange #FF6B35 for accent. Keyboard-navigable.
- Keep total source size under ~50 KB.

Runtime field — pick the right one for what the user asked for:
- "webview"      — the default. A normal fullscreen sandboxed window
                   (calculator, notes, calendar, text editor, etc).
- "panel-top"    — a thin horizontal strip docked at the very top of the
                   screen. Use for status bars, system summaries, ticker
                   tape. Layout the HTML as a single horizontal flexbox
                   ~32px tall — sway floats the window and pins it to
                   the top edge across all workspaces.
- "panel-bottom" — same idea, docked at the bottom. Use for taskbars,
                   activity indicators, "currently doing" surfaces.
- "panel-left" / "panel-right" — vertical strip docked at the left or
                   right edge. Use for vertical docks, source lists,
                   notification streams. Layout the HTML as a vertical
                   flexbox ~64-96px wide.
- "dock"         — a floating, draggable window the user can move. Use
                   for music player controls, screenshot tools.
- "widget"       — a small floating window that doesn't take focus.
                   Use for ambient surfaces (Pomodoro countdown,
                   weather pill). 200-300px square typical.
- "wallpaper"    — DO NOT use; wallpapers are set via the
                   SET_WALLPAPER action, not code generation.

For panels and widgets, design the HTML to fill its docked frame edge-
to-edge with NO margin/padding on the body, NO header chrome, and the
content centered inside the available space. The window manager handles
positioning — you just paint the strip.
`;

const SYSTEM_PROMPT_OUTPUT_SHAPE = `\
Output a JSON object matching the schema you were given. The two top-level
fields are:
  - "manifest": the manifest.json payload
  - "files": a map from relative paths (e.g. "src/index.html") to file contents

No additional fields, no surrounding prose, no markdown fences.
`;

export function buildSystemPrompt(): string {
    return `${SYSTEM_PROMPT_BASE}\n${SYSTEM_PROMPT_OUTPUT_SHAPE}`.trim();
}

export function buildUserPrompt(input: BriefInput): string {
    const lines: string[] = [];

    lines.push(`Slug: ${input.slug}`);
    lines.push(`Intent: ${input.intent}`);
    lines.push(`Builder ID (use as last_built_by): ${input.builderId}`);
    lines.push(`Timestamp (use as last_built_at): ${input.now}`);

    if (input.calibration !== null) {
        const cal = input.calibration;
        lines.push("");
        lines.push("User calibration (style hints, not technical constraints):");
        lines.push(`- name: ${cal.name}`);
        lines.push(`- chronotype: ${cal.chronotype}`);
        lines.push(`- multitasking: ${cal.multitasking}`);
        lines.push(`- error_communication: ${cal.errorCommunication}`);
    }

    if (input.existingSrc !== undefined && Object.keys(input.existingSrc).length > 0) {
        lines.push("");
        lines.push("Existing source — patch this in place; do not rewrite from scratch unless asked:");
        for (const [path, body] of Object.entries(input.existingSrc)) {
            lines.push(`--- ${path} ---`);
            lines.push(body);
            lines.push(`--- end ${path} ---`);
        }
    }

    if (input.critique !== undefined && input.critique.length > 0) {
        lines.push("");
        lines.push("Critique from previous attempt:");
        lines.push(input.critique);
    }

    return lines.join("\n");
}
