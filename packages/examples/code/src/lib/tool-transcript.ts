import path from "node:path";
import type { ActionEventPayload } from "@elizaos/core";

const HIDDEN_ACTIONS = new Set([
  "REPLY",
  "IGNORE",
  "NONE",
  "STOP",
  "FOLLOW_ROOM",
]);

interface FormatOptions {
  cwd?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readBoolean(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function readArray(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return Array.isArray(value) ? value : undefined;
}

function actionResult(
  payload: ActionEventPayload,
): Record<string, unknown> | null {
  const content = asRecord(payload.content);
  return asRecord(content?.actionResult);
}

function actionData(
  payload: ActionEventPayload,
): Record<string, unknown> | null {
  return asRecord(actionResult(payload)?.data);
}

function actionText(payload: ActionEventPayload): string | undefined {
  return readString(actionResult(payload), "text");
}

function shortPath(
  filePath: string | undefined,
  options: FormatOptions,
): string {
  if (!filePath) return "";
  const cwd = options.cwd;
  if (cwd && path.isAbsolute(filePath)) {
    const relative = path.relative(cwd, filePath);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      return relative;
    }
  }
  return filePath;
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function statusSuffix(payload: ActionEventPayload): string {
  const result = actionResult(payload);
  const success = readBoolean(result, "success") !== false;
  if (!success) return " failed";
  const data = actionData(payload);
  const exitCode = readNumber(data, "exit_code");
  return typeof exitCode === "number" ? ` exited ${exitCode}` : "";
}

function commandFromText(text: string | undefined): string | undefined {
  const firstLine = text?.split("\n")[0]?.trim();
  return firstLine?.startsWith("$ ") ? firstLine.slice(2).trim() : undefined;
}

function formatShell(payload: ActionEventPayload): string {
  const data = actionData(payload);
  const command =
    readString(data, "command") ?? commandFromText(actionText(payload));
  const suffix = statusSuffix(payload);
  return command ? `run ${command}${suffix}` : `run SHELL${suffix}`;
}

function formatFile(
  payload: ActionEventPayload,
  options: FormatOptions,
): string {
  const data = actionData(payload);
  const result = actionResult(payload);
  const success = readBoolean(result, "success") !== false;
  const filePath = shortPath(readString(data, "path"), options);
  const addedLines = readNumber(data, "addedLines");
  const removedLines = readNumber(data, "removedLines");
  const replacements = readNumber(data, "replacements");
  if (
    typeof addedLines === "number" ||
    typeof removedLines === "number" ||
    typeof replacements === "number"
  ) {
    return `edit ${filePath || "file"} +${addedLines ?? 0}/-${removedLines ?? 0}${success ? "" : " failed"}`;
  }

  const bytes = readNumber(data, "bytes");
  if (typeof bytes === "number") {
    return `write ${filePath || "file"} ${plural(bytes, "byte")}${success ? "" : " failed"}`;
  }

  const lines = readNumber(data, "lines");
  const totalLines = readNumber(data, "totalLines");
  if (typeof lines === "number") {
    const total = typeof totalLines === "number" ? `/${totalLines}` : "";
    return `read ${filePath || "file"} ${lines}${total} lines${success ? "" : " failed"}`;
  }

  const matches = readNumber(data, "matches_count");
  if (typeof matches === "number") {
    return `grep ${plural(matches, "match")}${success ? "" : " failed"}`;
  }

  const files = readArray(data, "files");
  if (files) {
    return `glob ${plural(files.length, "file")}${success ? "" : " failed"}`;
  }

  const entries = readArray(data, "entries");
  if (entries) {
    return `ls ${plural(entries.length, "entry")}${success ? "" : " failed"}`;
  }

  return `file ${success ? "done" : "failed"}`;
}

function formatWorktree(
  payload: ActionEventPayload,
  options: FormatOptions,
): string {
  const data = actionData(payload);
  const result = actionResult(payload);
  const success = readBoolean(result, "success") !== false;
  const entered = shortPath(readString(data, "worktreePath"), options);
  if (entered) return `worktree enter ${entered}${success ? "" : " failed"}`;
  const restored = shortPath(readString(data, "restoredTo"), options);
  if (restored) return `worktree exit ${restored}${success ? "" : " failed"}`;
  return `worktree ${success ? "done" : "failed"}`;
}

export function actionNameFromPayload(
  payload: ActionEventPayload,
): string | null {
  const actions = payload.content?.actions;
  const first = Array.isArray(actions) ? actions[0] : undefined;
  return typeof first === "string" && first.length > 0 ? first : null;
}

export function shouldShowToolAction(
  actionName: string | null,
): actionName is string {
  return Boolean(actionName && !HIDDEN_ACTIONS.has(actionName));
}

export function toolTranscriptKey(
  payload: ActionEventPayload,
  actionName: string,
): string {
  return `${payload.messageId ?? payload.roomId}:${actionName}`;
}

export function formatToolStarted(actionName: string): string {
  return `tool ${actionName.toLowerCase()}`;
}

export function formatToolCompleted(
  payload: ActionEventPayload,
  options: FormatOptions = {},
): string {
  const actionName = actionNameFromPayload(payload);
  switch (actionName) {
    case "SHELL":
      return formatShell(payload);
    case "FILE":
      return formatFile(payload, options);
    case "WORKTREE":
      return formatWorktree(payload, options);
    default: {
      const result = actionResult(payload);
      const success = readBoolean(result, "success") !== false;
      return `${actionName?.toLowerCase() ?? "tool"} ${success ? "done" : "failed"}`;
    }
  }
}
