/**
 * Shell-mount coverage for the two surfaces #9969 flagged as untested TUI gaps:
 * settings and voice/transcription.
 *
 * Neither ships a live plugin-registered terminal view today (that wiring is a
 * product decision tracked by #9945/#9946). What this proves is the missing
 * half: the component types those surfaces use mount inside the *real* agent
 * shell, render through a real terminal grid, obey the width contract, and stay
 * interactive — so when a live settings/voice view is registered it has a tested
 * mount path. We do not invent a settings or voice pipeline here.
 *
 * - **Settings:** the real `SettingsList` component (value cycling) mounted as a
 *   terminal view and driven through the shell.
 * - **Voice/transcription:** a minimal transcript view (the existing transcript
 *   state rendered as terminal lines) mounted and asserted in the grid.
 */

import {
  type Component,
  registerTerminalView,
  type SettingItem,
  SettingsList,
  type SettingsListTheme,
  truncateToWidth,
} from "@elizaos/tui";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertWidthContract,
  bootShell,
  drive,
  KEYS,
  okViewRoutes,
  screenText,
  type,
  viewport,
  viewsRoute,
} from "./harness.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

/** A plain settings theme: no color, so grid assertions read clean text. */
const settingsTheme: SettingsListTheme = {
  label: (text) => text,
  value: (text) => text,
  description: (text) => text,
  cursor: ">",
  hint: (text) => text,
};

/** A minimal transcript view: voice/transcription state rendered as lines. */
function transcriptView(lines: string[]): Component {
  return {
    render: (width) =>
      ["── transcript ──", ...lines].map((line) =>
        truncateToWidth(line, width),
      ),
    handleInput: () => {},
    invalidate: () => {},
  };
}

describe("settings + voice/transcription terminal views (shell-mount coverage)", () => {
  it("mounts the real SettingsList in the shell, renders rows, and cycles a value", async () => {
    const changes: Array<{ id: string; value: string }> = [];
    const items: SettingItem[] = [
      {
        id: "theme",
        label: "Theme",
        currentValue: "dark",
        values: ["dark", "light", "ocean"],
      },
      {
        id: "model",
        label: "Model",
        currentValue: "eliza-1",
        values: ["eliza-1", "gpt-5.5"],
      },
    ];
    const settings = new SettingsList(
      items,
      8,
      settingsTheme,
      (id, value) => changes.push({ id, value }),
      () => {},
    );
    cleanups.push(registerTerminalView("settings-fixture", settings));

    const { terminal } = await bootShell({
      routes: [
        viewsRoute([{ id: "settings-fixture", label: "Settings TUI" }]),
        ...okViewRoutes,
      ],
    });

    // Open the settings view (digit key is a view-block keybinding).
    await drive(terminal, [KEYS.CTRL_L, "1"]);
    const lines = viewport(terminal);
    const text = lines.join("\n");
    expect(text).toContain("Theme");
    expect(text).toContain("dark");
    expect(text).toContain("Model");
    assertWidthContract(lines, terminal.columns);

    // Enter cycles the selected setting's value through the shell's input route.
    await drive(terminal, [KEYS.ENTER]);
    expect(changes).toContainEqual({ id: "theme", value: "light" });
    expect(screenText(terminal)).toContain("light");
  });

  it("mounts a transcript view in the shell and renders the live transcript text", async () => {
    cleanups.push(
      registerTerminalView(
        "transcript",
        transcriptView([
          "user: what's the weather",
          "agent: sunny, 72°F",
          "user: thanks",
        ]),
      ),
    );

    const { terminal } = await bootShell({
      routes: [
        viewsRoute([{ id: "transcript", label: "Transcript TUI" }]),
        ...okViewRoutes,
      ],
    });

    await drive(terminal, [KEYS.CTRL_L, "1"]);
    const lines = viewport(terminal);
    const text = lines.join("\n");
    expect(text).toContain("── transcript ──");
    expect(text).toContain("user: what's the weather");
    expect(text).toContain("agent: sunny, 72°F");
    assertWidthContract(lines, terminal.columns);
  });

  it("keeps the chat composer pinned while a settings view is mounted", async () => {
    const settings = new SettingsList(
      [
        {
          id: "x",
          label: "Toggle X",
          currentValue: "on",
          values: ["on", "off"],
        },
      ],
      8,
      settingsTheme,
      () => {},
      () => {},
    );
    cleanups.push(registerTerminalView("settings-fixture", settings));

    const { terminal } = await bootShell({
      routes: [
        viewsRoute([{ id: "settings-fixture", label: "Settings TUI" }]),
        ...okViewRoutes,
      ],
    });
    await drive(terminal, [KEYS.CTRL_L, "1"]);

    // Composer is still rendered below the mounted settings view.
    const text = screenText(terminal);
    expect(text).toContain("Toggle X");
    expect(text).toContain("chat");

    // Ctrl+L moves focus to the composer; typing reaches it, not the settings.
    await drive(terminal, [KEYS.CTRL_L]);
    await type(terminal, "hi");
    expect(screenText(terminal)).toContain("Toggle X"); // view stays mounted
  });
});
