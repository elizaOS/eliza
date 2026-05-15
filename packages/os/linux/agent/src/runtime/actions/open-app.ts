// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { Action, IAgentRuntime, Memory } from "@elizaos/core";

import { extractSlot, slugify } from "../match.ts";
import { appsRoot } from "../paths.ts";

/**
 * Build an env that has the SWAYSOCK + WAYLAND_DISPLAY the user's sway
 * session uses, even though the agent itself runs from systemd (which
 * doesn't inherit them). Glob the runtime dir for the IPC + wayland
 * sockets sway writes on startup; cache nothing — sway PID rotates on
 * compositor restart so we always recompute.
 */
function swayEnv(): NodeJS.ProcessEnv {
  const xdg =
    process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`;
  const out: NodeJS.ProcessEnv = { ...process.env, XDG_RUNTIME_DIR: xdg };
  try {
    const entries = readdirSync(xdg);
    const ipc = entries.find((n) => /^sway-ipc\..*\.sock$/.test(n));
    if (ipc !== undefined) out.SWAYSOCK = `${xdg}/${ipc}`;
    const wl = entries.find((n) => /^wayland-\d+$/.test(n));
    if (wl !== undefined) out.WAYLAND_DISPLAY = wl;
  } catch {
    // Best-effort. swaymsg/chromium will surface a clear error.
  }
  return out;
}

const VERBS = ["open", "launch", "show", "run"] as const;

export const OPEN_APP_ACTION: Action = {
  name: "OPEN_APP",
  similes: [
    "open my calendar",
    "launch my notes",
    "open my app",
    "show my notes",
    "run my calendar",
    "open notes",
    "launch calendar",
  ],
  description:
    "Re-open a previously built app from the user's sandbox. Used when the user " +
    "says 'open my <thing>', 'launch my <thing>', 'show my <thing>'.",

  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text =
      typeof message.content.text === "string" ? message.content.text : "";
    return extractSlot(text, VERBS) !== null;
  },

  handler: async (_runtime, message, _state, _options, callback) => {
    const text =
      typeof message.content.text === "string" ? message.content.text : "";
    const target = extractSlot(text, VERBS);
    if (target === null) {
      return { success: false, text: "I couldn't tell what to open." };
    }
    const slug = slugify(target);
    const manifestPath = `${appsRoot()}/${slug}/manifest.json`;

    if (!existsSync(manifestPath)) {
      const reply = `I haven't built a "${target}" yet. Try "build me a ${target}" first.`;
      if (callback) await callback({ text: reply, actions: ["OPEN_APP"] });
      return { success: false, text: reply };
    }

    // Spawn the chromium webview directly via swaymsg exec. Elizad's
    // Tauri sandbox_launcher honors the `launch` payload below too,
    // but the bwrap path in v35 silently drops WAYLAND_DISPLAY so
    // chromium never actually paints. Firing `swaymsg exec chromium`
    // agent-side is the path that's verified working — sway's
    // `for_window [app_id="usbeliza.app.*"]` rule docks it correctly,
    // and the bigger sandbox-launcher rework is a follow-up.
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        entry?: string;
      };
      const entry =
        typeof manifest.entry === "string" ? manifest.entry : "src/index.html";
      const appDir = `${appsRoot()}/${slug}`;
      const url = `file://${appDir}/${entry}`;
      const chromium = "/usr/bin/chromium";
      // Use --app= to strip browser chrome (tab bar, URL bar) so
      // the user just sees the app surface. --class= maps to
      // Wayland app_id under newer chromium; the sway rule keys
      // off the prefix.
      spawn(
        "swaymsg",
        [
          "exec",
          `${chromium} --new-window --ozone-platform=wayland --enable-features=UseOzonePlatform --use-gl=swiftshader --class=usbeliza.app.${slug} --app=${url} --no-first-run --no-default-browser-check`,
        ],
        { stdio: "ignore", env: swayEnv() },
      ).unref();
    } catch (err) {
      const reply = `I tried to open ${target} but the window launcher failed: ${(err as Error).message}.`;
      if (callback) await callback({ text: reply, actions: ["OPEN_APP"] });
      return { success: false, text: reply };
    }

    const reply = `Opening your ${target}.`;
    if (callback) {
      await callback({
        text: reply,
        actions: ["OPEN_APP"],
        data: { launch: { slug, manifestPath, backend: "cache" } },
      });
    }
    return {
      success: true,
      text: reply,
      data: {
        actionName: "OPEN_APP",
        launch: { slug, manifestPath, backend: "cache" },
      },
    };
  },

  examples: [
    [
      { name: "{{user}}", content: { text: "open my calendar" } },
      { name: "Eliza", content: { text: "Opening your calendar." } },
    ],
  ],
};
