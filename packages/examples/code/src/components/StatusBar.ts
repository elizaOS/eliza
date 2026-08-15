// Renders a reusable UI component for the Code example.
import type { Component } from "@elizaos/tui";
import chalk from "chalk";
import { getCwd } from "../lib/cwd.js";
import { describeActiveModel } from "../lib/model-provider.js";
import { useStore } from "../lib/store.js";

/** Longest model label shown in the status bar before eliding. */
const MODEL_LABEL_MAX = 22;

export class StatusBar implements Component {
  private cwd = getCwd();
  private lastCwdCheck = Date.now();

  invalidate(): void {}

  render(width: number): string[] {
    // Periodically update CWD
    const now = Date.now();
    if (now - this.lastCwdCheck > 500) {
      this.cwd = getCwd();
      this.lastCwdCheck = now;
    }

    const state = useStore.getState();
    const isLoading = state.isLoading;
    const tasks = state.tasks;
    const rooms = state.rooms;
    const currentRoomId = state.currentRoomId;

    const currentRoom = rooms.find((r) => r.id === currentRoomId);
    const roomIndex = rooms.findIndex((r) => r.id === currentRoomId) + 1;

    const taskCounts = {
      running: tasks.filter((t) => t.metadata?.status === "running").length,
      completed: tasks.filter((t) => t.metadata?.status === "completed").length,
      failed: tasks.filter((t) => t.metadata?.status === "failed").length,
      cancelled: tasks.filter((t) => t.metadata?.status === "cancelled").length,
    };

    const showFullRight = width >= 80;
    const showMediumRight = width >= 60;

    // Room segment first — its real width feeds the layout math below (a fixed
    // slack constant here overflowed the bar with long room names).
    const maxRoomNameLen = 20;
    const roomName = currentRoom?.name ?? "Chat";
    const shortRoomName =
      roomName.length > maxRoomNameLen
        ? `${roomName.slice(0, maxRoomNameLen - 1)}…`
        : roomName;
    const roomDecor = ` (${roomIndex}/${rooms.length}) | `;
    // Borders + surrounding spaces: "│ " … " │".
    const frameOverhead = 4;
    const leftFixedLen =
      shortRoomName.length + roomDecor.length + frameOverhead;

    // Active model/provider — the "which model am I talking to" indicator every
    // comparable coding TUI shows. Only at full width (the bar is already busy
    // below 80), elided to a sane length, and omitted entirely when no provider
    // is configured (describeActiveModel returns null rather than throwing).
    const modelLabelRaw = showFullRight ? describeActiveModel() : null;
    const modelLabel =
      modelLabelRaw && modelLabelRaw.length > MODEL_LABEL_MAX
        ? `${modelLabelRaw.slice(0, MODEL_LABEL_MAX - 1)}…`
        : modelLabelRaw;

    const rightBasePlain = showFullRight
      ? `Tasks r${taskCounts.running} c${taskCounts.completed} f${taskCounts.failed} x${taskCounts.cancelled}${isLoading ? " …" : ""} | ?`
      : showMediumRight
        ? `Tasks r${taskCounts.running} f${taskCounts.failed}${isLoading ? " …" : ""} | ?`
        : `Tasks r${taskCounts.running}${isLoading ? " …" : ""} | ?`;

    // Include the model indicator only when it fits without pushing the cwd
    // below its 10-char floor — prefer dropping the indicator over overflowing
    // the bar (which the screen would clip, cutting off the right border).
    const modelPrefixCandidate = modelLabel ? `${modelLabel} | ` : "";
    const modelPrefix =
      modelPrefixCandidate.length > 0 &&
      width -
        (rightBasePlain.length + modelPrefixCandidate.length) -
        leftFixedLen >=
        10
        ? modelPrefixCandidate
        : "";
    const rightTextPlain = `${modelPrefix}${rightBasePlain}`;

    const maxCwdLen = Math.max(
      10,
      width - rightTextPlain.length - leftFixedLen,
    );
    const shortCwd =
      this.cwd.length > maxCwdLen
        ? `...${this.cwd.slice(-(maxCwdLen - 3))}`
        : this.cwd;

    // Build the status bar
    const innerWidth = Math.max(1, width - 4);

    // Last resort at narrow widths: with the cwd already at its floor, elide
    // the room name down to what actually fits rather than overflowing (the
    // screen would clip the line, cutting off the right border and help hint).
    const overflowBy =
      shortRoomName.length +
      roomDecor.length +
      shortCwd.length +
      rightTextPlain.length -
      innerWidth;
    const finalRoomName =
      overflowBy > 0
        ? `${shortRoomName.slice(0, Math.max(1, shortRoomName.length - overflowBy - 1))}…`
        : shortRoomName;

    const leftText = `${chalk.bold.magenta(finalRoomName)} ${chalk.dim(`(${roomIndex}/${rooms.length})`)} ${chalk.dim("|")} ${chalk.cyan(shortCwd)}`;
    const rightText = chalk.dim(rightTextPlain);

    // Calculate padding to right-align the right text
    const leftLen = finalRoomName.length + roomDecor.length + shortCwd.length;
    const rightLen = rightTextPlain.length;
    const padding = Math.max(0, innerWidth - leftLen - rightLen);

    const borderColor = chalk.gray;
    const topBorder = borderColor(`┌${"─".repeat(innerWidth)}┐`);
    const bottomBorder = borderColor(`└${"─".repeat(innerWidth)}┘`);
    const content = `${borderColor("│")} ${leftText}${" ".repeat(padding)}${rightText} ${borderColor("│")}`;

    return [topBorder, content, bottomBorder];
  }
}
