/**
 * Canvas2D rendering functions for the 3D scene overlay panels.
 *
 * Each function paints a panel onto a provided CanvasRenderingContext2D
 * using a light construct aesthetic: translucent frosted-glass panels,
 * subtle borders, dark text on light backgrounds.
 */

import { getSceneTokens } from "./scene-theme-tokens";

// -- Design tokens (resolved from CSS vars at paint time) ---------------------
// Kept as module-level aliases so existing call-sites compile unchanged.
// Functions that paint call `refreshTokens()` at the top of each frame.
let _t = getSceneTokens();
let ACCENT = _t.accent;
let TEXT_PRIMARY = _t.textPrimary;
let TEXT_SECONDARY = _t.textSecondary;
let TEXT_MUTED = _t.textMuted;
let STATUS_GREEN = _t.statusGreen;
let STATUS_RED = _t.statusRed;
let STATUS_YELLOW = _t.statusYellow;
let STATUS_BLUE = _t.statusBlue;
let FONT_SANS = _t.fontSans;
let FONT_MONO = _t.fontMono;

/** Re-read CSS custom properties so canvas colors track the active theme. */
export function refreshTokens() {
  _t = getSceneTokens();
  ACCENT = _t.accent;
  TEXT_PRIMARY = _t.textPrimary;
  TEXT_SECONDARY = _t.textSecondary;
  TEXT_MUTED = _t.textMuted;
  STATUS_GREEN = _t.statusGreen;
  STATUS_RED = _t.statusRed;
  STATUS_YELLOW = _t.statusYellow;
  STATUS_BLUE = _t.statusBlue;
  FONT_SANS = _t.fontSans;
  FONT_MONO = _t.fontMono;
}

// -- Shared types -------------------------------------------------------------

export interface ChatOverlayMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export interface AgentStatusOverlay {
  state: string;
  agentName: string;
  uptime?: number;
  sessions: Array<{
    sessionId: string;
    label: string;
    agentType: string;
  }>;
}

export interface TriggerOverlay {
  id: string;
  displayName: string;
  triggerType: string;
  enabled: boolean;
  lastStatus?: string;
  cronExpression?: string;
  intervalMs?: number;
}

// -- Helpers ------------------------------------------------------------------

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    if (ctx.measureText(testLine).width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

function drawStatusDot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  radius = 6,
): void {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = 6;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

function formatUptimeMs(ms: number | undefined): string {
  if (ms == null || ms <= 0) return "--";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatInterval(ms: number | undefined): string {
  if (!ms) return "";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `every ${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `every ${hours}h`;
}

function agentStateColor(state: string): string {
  switch (state) {
    case "running":
      return STATUS_GREEN;
    case "starting":
    case "restarting":
      return STATUS_YELLOW;
    case "error":
      return STATUS_RED;
    default:
      return TEXT_MUTED;
  }
}

function triggerStatusColor(status: string | undefined): string {
  switch (status) {
    case "success":
      return STATUS_GREEN;
    case "error":
      return STATUS_RED;
    case "skipped":
      return STATUS_YELLOW;
    default:
      return TEXT_MUTED;
  }
}

// -- Panel renderers ----------------------------------------------------------

export function renderChatPanel(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  messages: ChatOverlayMessage[],
): void {
  refreshTokens();
  ctx.clearRect(0, 0, w, h);

  const pad = 10;
  const bubbleMaxWidth = w - pad * 2 - 12;
  const fontSize = 11;
  const lineHeight = fontSize * 1.35;
  const bubblePadX = 10;
  const bubblePadY = 6;
  const bubbleRadius = 10;
  const bubbleGap = 4;

  const visibleMessages = messages.slice(-10);
  if (visibleMessages.length === 0) return;

  // Pre-calculate all bubble heights to bottom-align
  const bubbleInfos: Array<{
    msg: ChatOverlayMessage;
    lines: string[];
    height: number;
  }> = [];
  for (const msg of visibleMessages) {
    ctx.font = `400 ${fontSize}px ${FONT_SANS}`;
    const truncatedText =
      msg.text.length > 200 ? `${msg.text.slice(0, 197)}...` : msg.text;
    const lines = wrapText(ctx, truncatedText, bubbleMaxWidth - bubblePadX * 2);
    const height = lines.length * lineHeight + bubblePadY * 2;
    bubbleInfos.push({ msg, lines, height });
  }

  let y = h - pad;

  for (let i = bubbleInfos.length - 1; i >= 0; i--) {
    const bubbleInfo = bubbleInfos[i];
    if (!bubbleInfo) continue;
    const { msg, lines, height } = bubbleInfo;
    const isUser = msg.role === "user";
    const bubbleWidth = Math.min(
      bubbleMaxWidth,
      Math.max(...lines.map((l) => ctx.measureText(l).width)) +
        bubblePadX * 2 +
        4,
    );

    y -= height;
    if (y < 0) break;

    const bubbleX = isUser ? w - pad - bubbleWidth : pad;

    if (isUser) {
      // User bubble — soft blue tint
      roundRect(ctx, bubbleX, y, bubbleWidth, height, bubbleRadius);
      const grad = ctx.createLinearGradient(bubbleX, y, bubbleX, y + height);
      grad.addColorStop(0, "rgba(58, 123, 213, 0.14)");
      grad.addColorStop(1, "rgba(58, 123, 213, 0.06)");
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = "rgba(58, 123, 213, 0.25)";
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      // Assistant bubble — frosted white card
      roundRect(ctx, bubbleX, y, bubbleWidth, height, bubbleRadius);
      const grad = ctx.createLinearGradient(bubbleX, y, bubbleX, y + height);
      grad.addColorStop(0, "rgba(255, 255, 255, 0.85)");
      grad.addColorStop(1, "rgba(240, 243, 248, 0.9)");
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = "rgba(0, 0, 0, 0.08)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Text
    ctx.fillStyle = TEXT_PRIMARY;
    ctx.font = `400 ${fontSize}px ${FONT_SANS}`;
    let textY = y + bubblePadY + fontSize;
    for (const line of lines) {
      ctx.fillText(line, bubbleX + bubblePadX, textY);
      textY += lineHeight;
    }

    y -= bubbleGap;
  }
}

export function renderStatusPanel(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  status: AgentStatusOverlay | null,
): void {
  refreshTokens();
  ctx.clearRect(0, 0, w, h);

  const pad = 12;
  const fs = 12;
  const fsMono = 10;

  // Frosted panel frame
  ctx.save();
  ctx.strokeStyle = "rgba(58, 123, 213, 0.2)";
  ctx.lineWidth = 1;
  const cx = 10;
  ctx.beginPath();
  ctx.moveTo(pad + cx, pad);
  ctx.lineTo(w - pad, pad);
  ctx.lineTo(w - pad, h - pad - cx);
  ctx.lineTo(w - pad - cx, h - pad);
  ctx.lineTo(pad, h - pad);
  ctx.lineTo(pad, pad + cx);
  ctx.closePath();
  ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // Top accent line
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(pad + cx, pad);
  ctx.lineTo(pad + cx + 50, pad);
  ctx.stroke();

  let y = pad + 16;

  ctx.font = `600 ${fsMono}px ${FONT_MONO}`;
  ctx.fillStyle = ACCENT;
  ctx.fillText("SYS:STATUS", pad + 8, y);
  y += 14;

  if (!status) {
    ctx.font = `400 ${fsMono}px ${FONT_MONO}`;
    ctx.fillStyle = TEXT_MUTED;
    ctx.fillText("OFFLINE", pad + 8, y + 10);
    return;
  }

  const stateColor = agentStateColor(status.state);

  drawStatusDot(ctx, pad + 14, y + 5, stateColor, 3);
  ctx.font = `500 ${fs}px ${FONT_SANS}`;
  ctx.fillStyle = TEXT_PRIMARY;
  ctx.fillText(status.state.toUpperCase(), pad + 24, y + 9);

  ctx.font = `400 ${fsMono}px ${FONT_MONO}`;
  ctx.fillStyle = TEXT_SECONDARY;
  const uptimeStr = formatUptimeMs(status.uptime);
  const uptimeW = ctx.measureText(uptimeStr).width;
  ctx.fillText(uptimeStr, w - pad - uptimeW - 8, y + 9);
  y += 18;

  ctx.strokeStyle = "rgba(58, 123, 213, 0.1)";
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(pad + 8, y);
  ctx.lineTo(w - pad - 8, y);
  ctx.stroke();
  y += 8;

  ctx.font = `400 ${fsMono}px ${FONT_MONO}`;
  ctx.fillStyle = TEXT_MUTED;
  ctx.fillText((status.agentName || "agent").toUpperCase(), pad + 8, y + 8);
  y += 16;

  if (status.sessions.length > 0) {
    for (const session of status.sessions.slice(0, 3)) {
      if (y > h - pad - 8) break;
      drawStatusDot(ctx, pad + 14, y + 5, STATUS_BLUE, 2.5);
      ctx.font = `400 ${fsMono}px ${FONT_MONO}`;
      ctx.fillStyle = TEXT_SECONDARY;
      const label =
        session.label.length > 22
          ? `${session.label.slice(0, 19)}...`
          : session.label;
      ctx.fillText(label, pad + 22, y + 8);
      y += 14;
    }
  }
}

export function renderHeartbeatsPanel(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  triggers: TriggerOverlay[],
): void {
  refreshTokens();
  ctx.clearRect(0, 0, w, h);

  const pad = 12;
  const fsMono = 10;

  // Frosted panel frame
  ctx.save();
  ctx.strokeStyle = "rgba(58, 123, 213, 0.2)";
  ctx.lineWidth = 1;
  const cx = 10;
  ctx.beginPath();
  ctx.moveTo(pad + cx, pad);
  ctx.lineTo(w - pad, pad);
  ctx.lineTo(w - pad, h - pad - cx);
  ctx.lineTo(w - pad - cx, h - pad);
  ctx.lineTo(pad, h - pad);
  ctx.lineTo(pad, pad + cx);
  ctx.closePath();
  ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // Top accent line
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(pad + cx, pad);
  ctx.lineTo(pad + cx + 50, pad);
  ctx.stroke();

  let y = pad + 16;

  ctx.font = `600 ${fsMono}px ${FONT_MONO}`;
  ctx.fillStyle = ACCENT;
  ctx.fillText("SYS:HEARTBEAT", pad + 8, y);
  y += 14;

  if (triggers.length === 0) {
    ctx.font = `400 ${fsMono}px ${FONT_MONO}`;
    ctx.fillStyle = TEXT_MUTED;
    ctx.fillText("NO TRIGGERS", pad + 8, y + 8);
    return;
  }

  for (const trigger of triggers.slice(0, 6)) {
    if (y > h - pad - 8) break;

    drawStatusDot(
      ctx,
      pad + 14,
      y + 5,
      trigger.enabled ? STATUS_GREEN : TEXT_MUTED,
      2.5,
    );

    ctx.font = `400 ${fsMono}px ${FONT_MONO}`;
    ctx.fillStyle = trigger.enabled ? TEXT_PRIMARY : TEXT_MUTED;
    const name =
      trigger.displayName.length > 18
        ? `${trigger.displayName.slice(0, 15)}...`
        : trigger.displayName;
    ctx.fillText(name, pad + 22, y + 8);

    const scheduleText =
      trigger.triggerType === "cron"
        ? (trigger.cronExpression ?? "cron")
        : trigger.triggerType === "interval"
          ? formatInterval(trigger.intervalMs)
          : "once";
    ctx.fillStyle = TEXT_MUTED;
    const schedW = ctx.measureText(scheduleText).width;
    ctx.fillText(scheduleText, w - pad - schedW - 8, y + 8);

    if (trigger.lastStatus) {
      drawStatusDot(
        ctx,
        w - pad - 4,
        y + 5,
        triggerStatusColor(trigger.lastStatus),
        2,
      );
    }

    y += 16;
  }
}
