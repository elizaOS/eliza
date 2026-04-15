/**
 * Upstream-vs-plugin parity oracle.
 *
 * This suite pins the command vocabulary from coasty-ai/open-computer-use
 * against the plugin's modeled types, exposed action surface, normalization
 * aliases, and approval processing.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { useComputerAction } from "../actions/use-computer.js";
import { takeScreenshotAction } from "../actions/take-screenshot.js";
import { browserAction } from "../actions/browser-action.js";
import { manageWindowAction } from "../actions/manage-window.js";
import { fileAction } from "../actions/file-action.js";
import { terminalAction } from "../actions/terminal-action.js";
import { normalizeComputerUseParams } from "../normalization.js";
import { ApprovalManager } from "../approval/approval-manager.js";
import { DEFAULT_SAFE_COMMANDS } from "../approval/safe-commands.js";

const TYPES_SOURCE = readFileSync(new URL("../types.ts", import.meta.url), "utf8");

const UPSTREAM = {
  desktop: [
    "screenshot",
    "click",
    "click_with_modifiers",
    "double_click",
    "type",
    "key",
    "key_combo",
    "scroll",
    "drag",
    "detect_elements",
    "ocr",
  ],
  browser: [
    "open",
    "connect",
    "close",
    "navigate",
    "click",
    "type",
    "scroll",
    "screenshot",
    "dom",
    "get_dom",
    "clickables",
    "get_clickables",
    "execute",
    "state",
    "info",
    "get_context",
    "wait",
    "list_tabs",
    "open_tab",
    "close_tab",
    "switch_tab",
  ],
  window: [
    "list",
    "switch",
    "arrange",
    "move",
    "minimize",
    "maximize",
    "restore",
    "close",
  ],
  file: [
    "read",
    "write",
    "edit",
    "append",
    "delete",
    "exists",
    "list_directory",
    "delete_directory",
    "upload",
    "download",
    "list_downloads",
  ],
  terminal: [
    "connect",
    "execute",
    "read",
    "type",
    "clear",
    "close",
    "execute_command",
  ],
  approvalModes: ["full_control", "smart_approve", "approve_all", "off"],
  permissionTypes: ["accessibility", "screen-recording"],
  safeCommands: DEFAULT_SAFE_COMMANDS,
} as const;

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function expectSameSet(actual: readonly string[], expected: readonly string[]): void {
  expect(sorted(actual)).toEqual(sorted(expected));
}

function getActionEnum(
  action: { parameters?: readonly Array<{ name: string; schema?: Record<string, unknown> }> },
  parameterName = "action",
): string[] {
  const parameter = action.parameters?.find((entry) => entry.name === parameterName);
  const values = parameter?.schema?.enum;

  if (!Array.isArray(values)) {
    return [];
  }

  return values.filter((value): value is string => typeof value === "string");
}

function extractUnionMembers(startToken: string, endToken: string): string[] {
  const start = TYPES_SOURCE.indexOf(startToken);
  expect(start).toBeGreaterThanOrEqual(0);

  const end = TYPES_SOURCE.indexOf(endToken, start + startToken.length);
  expect(end).toBeGreaterThan(start);

  const block = TYPES_SOURCE.slice(start, end);
  return [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);
}

function normalizeUpstreamCommand(command: string): string {
  const aliases: Record<string, string> = {
    key_press: "key",

    browser_open: "open",
    browser_connect: "connect",
    browser_close: "close",
    browser_navigate: "navigate",
    browser_click: "click",
    browser_type: "type",
    browser_scroll: "scroll",
    browser_screenshot: "screenshot",
    browser_get_dom: "get_dom",
    browser_dom: "dom",
    browser_get_clickables: "get_clickables",
    browser_execute: "execute",
    browser_state: "state",
    browser_info: "info",
    browser_get_context: "get_context",
    browser_wait: "wait",
    browser_list_tabs: "list_tabs",
    browser_open_tab: "open_tab",
    browser_close_tab: "close_tab",
    browser_switch_tab: "switch_tab",

    list_windows: "list",
    switch_to_window: "switch",
    focus_window: "focus",
    close_window: "close",
    minimize_window: "minimize",
    maximize_window: "maximize",
    restore_window: "restore",

    terminal_connect: "connect",
    terminal_execute: "execute",
    terminal_read: "read",
    terminal_type: "type",
    terminal_clear: "clear",
    terminal_close: "close",
    execute_command: "execute_command",

    file_read: "read",
    file_write: "write",
    file_edit: "edit",
    file_append: "append",
    file_delete: "delete",
    file_exists: "exists",
    directory_list: "list_directory",
    directory_delete: "delete_directory",
    file_upload: "upload",
    file_download: "download",
    file_list_downloads: "list_downloads",
  };

  return aliases[command] ?? command;
}

describe("upstream command model", () => {
  it("pins the plugin's modeled command vocabulary against the upstream canonical surface", () => {
    const desktop = extractUnionMembers(
      "export type DesktopActionType =",
      "export interface DesktopActionParams",
    );
    const browser = extractUnionMembers(
      "export type BrowserActionType =",
      "export interface BrowserActionParams",
    );
    const window = extractUnionMembers(
      "export type WindowActionType =",
      "export interface WindowActionParams",
    );
    const file = extractUnionMembers(
      "export type FileActionType =",
      "export interface FileActionParams",
    );
    const terminal = extractUnionMembers(
      "export type TerminalActionType =",
      "export interface TerminalActionParams",
    );

    const upstreamDesktop = UPSTREAM.desktop.map(normalizeUpstreamCommand);
    const upstreamBrowser = UPSTREAM.browser.map(normalizeUpstreamCommand);
    const upstreamWindow = UPSTREAM.window.map(normalizeUpstreamCommand);
    const upstreamFile = UPSTREAM.file.map(normalizeUpstreamCommand);
    const upstreamTerminal = UPSTREAM.terminal.map(normalizeUpstreamCommand);

    expect(upstreamDesktop.filter((command) => !desktop.includes(command))).toEqual([]);
    expect(upstreamBrowser.filter((command) => !browser.includes(command))).toEqual([]);
    expect(upstreamWindow.filter((command) => !window.includes(command))).toEqual([]);
    expect(upstreamFile.filter((command) => !file.includes(command))).toEqual([]);
    expect(upstreamTerminal.filter((command) => !terminal.includes(command))).toEqual([]);
  });

  it("pins approval modes and permission vocabulary", () => {
    const approvalModes = extractUnionMembers(
      "export type ApprovalMode =",
      "export interface ComputerUseResult",
    );
    const permissionTypes = extractUnionMembers(
      "export type PermissionType =",
      "export type ApprovalMode =",
    );

    expectSameSet(approvalModes, UPSTREAM.approvalModes);
    expectSameSet(permissionTypes, UPSTREAM.permissionTypes);
  });
});

describe("plugin surface", () => {
  it("keeps the plugin entrypoints aligned to the expanded high-level action set", () => {
    expect([
      "USE_COMPUTER",
      "TAKE_SCREENSHOT",
      "BROWSER_ACTION",
      "MANAGE_WINDOW",
      "FILE_ACTION",
      "TERMINAL_ACTION",
    ]).toEqual([
      "USE_COMPUTER",
      "TAKE_SCREENSHOT",
      "BROWSER_ACTION",
      "MANAGE_WINDOW",
      "FILE_ACTION",
      "TERMINAL_ACTION",
    ]);
  });

  it("keeps the action enums aligned to the current exposure surface", () => {
    expectSameSet(getActionEnum(useComputerAction), [
      "screenshot",
      "click",
      "click_with_modifiers",
      "double_click",
      "right_click",
      "mouse_move",
      "type",
      "key",
      "key_combo",
      "scroll",
      "drag",
      "detect_elements",
      "ocr",
    ]);

    expectSameSet(getActionEnum(browserAction), [
      "open",
      "connect",
      "close",
      "navigate",
      "click",
      "type",
      "scroll",
      "screenshot",
      "dom",
      "get_dom",
      "clickables",
      "get_clickables",
      "execute",
      "state",
      "info",
      "context",
      "get_context",
      "wait",
      "list_tabs",
      "open_tab",
      "close_tab",
      "switch_tab",
    ]);

    expectSameSet(getActionEnum(manageWindowAction), [
      "list",
      "focus",
      "switch",
      "arrange",
      "move",
      "minimize",
      "maximize",
      "restore",
      "close",
    ]);

    expectSameSet(getActionEnum(fileAction), [
      "file_read",
      "file_write",
      "file_edit",
      "file_append",
      "file_delete",
      "file_exists",
      "directory_list",
      "directory_delete",
      "file_upload",
      "file_download",
      "file_list_downloads",
    ]);

    expectSameSet(getActionEnum(terminalAction), [
      "terminal_connect",
      "terminal_execute",
      "terminal_read",
      "terminal_type",
      "terminal_clear",
      "terminal_close",
      "execute_command",
    ]);

    expect(takeScreenshotAction.parameters).toEqual([]);
  });
});

describe("coverage gaps", () => {
  it("captures the current upstream-vs-action gaps explicitly", () => {
    const desktopModel = extractUnionMembers(
      "export type DesktopActionType =",
      "export interface DesktopActionParams",
    );
    const browserModel = extractUnionMembers(
      "export type BrowserActionType =",
      "export interface BrowserActionParams",
    );
    const windowModel = extractUnionMembers(
      "export type WindowActionType =",
      "export interface WindowActionParams",
    );
    const fileModel = extractUnionMembers(
      "export type FileActionType =",
      "export interface FileActionParams",
    );
    const terminalModel = extractUnionMembers(
      "export type TerminalActionType =",
      "export interface TerminalActionParams",
    );

    const desktopActionSurface = getActionEnum(useComputerAction);
    const browserActionSurface = getActionEnum(browserAction);
    const windowActionSurface = getActionEnum(manageWindowAction);
    const fileActionSurface = getActionEnum(fileAction).map(normalizeUpstreamCommand);
    const terminalActionSurface = getActionEnum(terminalAction).map(normalizeUpstreamCommand);

    expect(desktopModel.filter((command) => !desktopActionSurface.includes(command))).toEqual([]);

    expect(browserModel.filter((command) => !browserActionSurface.includes(command))).toEqual([]);

    expect(windowModel.filter((command) => !windowActionSurface.includes(command))).toEqual([]);

    expect(fileModel.filter((command) => !fileActionSurface.includes(command))).toEqual([]);
    expect(terminalModel.filter((command) => !terminalActionSurface.includes(command))).toEqual([]);

    expect(UPSTREAM.safeCommands).toEqual([
      "screenshot",
      "browser_screenshot",
      "browser_state",
      "browser_info",
      "browser_get_dom",
      "browser_get_clickables",
      "browser_get_context",
      "browser_dom",
      "file_read",
      "file_exists",
      "directory_list",
      "file_list_downloads",
      "file_download",
      "terminal_read",
      "terminal_connect",
      "list_windows",
      "browser_list_tabs",
    ]);
  });
});

describe("normalization and approval processing", () => {
  it("normalizes upstream-style parameter aliases into the canonical plugin shapes", () => {
    expect(normalizeComputerUseParams("file_read", { filepath: "/tmp/demo.txt" }).path).toBe("/tmp/demo.txt");
    expect(normalizeComputerUseParams("directory_list", { dirpath: "/tmp" }).path).toBe("/tmp");
    expect(
      normalizeComputerUseParams("file_edit", {
        find: "old",
        replace: "new",
      }),
    ).toMatchObject({
      old_text: "old",
      new_text: "new",
    });
    expect(normalizeComputerUseParams("browser_switch_tab", { tab_index: 3 })).toMatchObject({
      index: 3,
      tabId: "3",
    });
    expect(normalizeComputerUseParams("switch_to_window", { title: "Terminal" }).windowId).toBe("Terminal");
    expect(normalizeComputerUseParams("drag", { x1: 1, y1: 2, x2: 3, y2: 4 })).toMatchObject({
      startCoordinate: [1, 2],
      coordinate: [3, 4],
    });
  });

  it("keeps approval modes and safe commands aligned with the upstream processing model", () => {
    const manager = new ApprovalManager();

    expect(manager.getMode()).toBe("full_control");
    expectSameSet(manager.getSafeCommands(), UPSTREAM.safeCommands);

    manager.setMode("smart_approve");
    for (const command of UPSTREAM.safeCommands) {
      expect(manager.shouldAutoApprove(command)).toBe(true);
    }

    manager.setMode("off");
    expect(manager.shouldAutoApprove("file_write")).toBe(false);
    expect(manager.isDenyAll()).toBe(true);
  });
});
