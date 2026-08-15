/**
 * Source ratchet: DesktopWorkspaceSection must expose one SettingsRow per
 * action instead of a multi-action grid inside a single SettingsRow.
 * Reads the shipped file off disk.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "DesktopWorkspaceSection.tsx"),
  "utf8",
);

const REQUIRED_AGENT_IDS = [
  "desktop-refresh-diagnostics",
  "desktop-open-settings-window",
  "desktop-refresh-logs",
  "desktop-copy-dev-stack",
  "desktop-copy-diagnostics-bundle",
  "desktop-console-refresh-tail",
  "desktop-console-copy-tail",
  "desktop-show-window",
  "desktop-hide-window",
  "desktop-focus-window",
  "desktop-minimize-window",
  "desktop-maximize-toggle",
  "desktop-notify",
  "desktop-restart-agent",
  "desktop-relaunch-app",
  "desktop-toggle-auto-launch",
  "desktop-toggle-hidden-launch",
  "desktop-open-file-dialog",
  "desktop-open-folder-dialog",
  "desktop-save-dialog",
  "desktop-clipboard-read",
  "desktop-clipboard-copy",
  "desktop-clipboard-clear",
];

describe("DesktopWorkspaceSection compound-row ratchet", () => {
  it("does not host a multi-action grid inside one SettingsRow", () => {
    expect(source).not.toMatch(/grid gap-2 sm:grid-cols-2/);
    expect(source).toContain("function WorkspaceActionRow");
  });

  it("keeps every existing desktop action agent id", () => {
    for (const id of REQUIRED_AGENT_IDS) {
      expect(source).toContain(`agentId="${id}"`);
    }
  });
});
