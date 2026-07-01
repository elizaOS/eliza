/**
 * MCP tool catalog for computer-use (#9170 — trycua/cua parity: optional MCP
 * server seam). Exposes the desktop computer-use verbs as Model Context Protocol
 * tools so an external MCP client (Claude Desktop, Cursor, Cline, …) can drive
 * this machine — the same surface domdomegg/computer-use-mcp offers, but backed
 * by our full driver + approval stack.
 *
 * This module is PURE (no MCP SDK import): it defines the tool catalog and the
 * dispatch mapping (MCP tool name → `ComputerUseService.executeCommand` command),
 * so it is unit-testable without the SDK or a live desktop. `server.ts` wires
 * this catalog into an actual MCP server transport.
 */

import type { ComputerUseResult } from "../types.js";

/** Minimal surface of ComputerUseService that the MCP dispatch needs. */
export interface ComputerUseCommandRunner {
  executeCommand(
    command: string,
    parameters?: Record<string, unknown>,
  ): Promise<ComputerUseResult>;
}

/** JSON-schema-ish property descriptor for an MCP tool input. */
export interface McpToolProperty {
  type: "string" | "number" | "boolean" | "array" | "object";
  description: string;
  items?: { type: string };
}

export interface ComputerUseMcpTool {
  /** MCP tool name exposed to clients (cua-style, snake_case). */
  name: string;
  description: string;
  /** ComputerUseService.executeCommand command this tool dispatches to. */
  command: string;
  /** Whether the verb mutates the host (→ goes through the approval manager). */
  destructive: boolean;
  /** Declared inputs (for the MCP inputSchema). */
  properties: Record<string, McpToolProperty>;
  required?: string[];
}

const COORD: McpToolProperty = {
  type: "array",
  description: "[x, y] pixel coordinate local to `displayId`.",
  items: { type: "number" },
};
const DISPLAY: McpToolProperty = {
  type: "number",
  description: "Target display id (from the computer-state provider).",
};

/**
 * The catalog. Every `command` here is a real desktop verb accepted by
 * `ComputerUseService.executeCommand` (kept in sync with that switch + the
 * parity matrix). Read-only verbs (`destructive: false`) auto-approve under
 * smart_approve; the rest are approval-gated.
 */
export const COMPUTERUSE_MCP_TOOLS: readonly ComputerUseMcpTool[] = [
  {
    name: "computer_screenshot",
    description: "Capture a screenshot of a display.",
    command: "screenshot",
    destructive: false,
    properties: { displayId: DISPLAY },
  },
  {
    name: "computer_get_cursor_position",
    description: "Read the current OS cursor position.",
    command: "get_cursor_position",
    destructive: false,
    properties: {},
  },
  {
    name: "computer_ocr",
    description: "Full-screen OCR; returns text + coordinate-bearing blocks.",
    command: "ocr",
    destructive: false,
    properties: { displayId: DISPLAY },
  },
  {
    name: "computer_detect_elements",
    description: "Detect interactable UI elements with coordinates.",
    command: "detect_elements",
    destructive: false,
    properties: { displayId: DISPLAY },
  },
  {
    name: "computer_left_click",
    description: "Left-click at a coordinate.",
    command: "click",
    destructive: true,
    properties: { coordinate: COORD, displayId: DISPLAY },
    required: ["coordinate"],
  },
  {
    name: "computer_right_click",
    description: "Right-click at a coordinate.",
    command: "right_click",
    destructive: true,
    properties: { coordinate: COORD, displayId: DISPLAY },
    required: ["coordinate"],
  },
  {
    name: "computer_double_click",
    description: "Double-click at a coordinate.",
    command: "double_click",
    destructive: true,
    properties: { coordinate: COORD, displayId: DISPLAY },
    required: ["coordinate"],
  },
  {
    name: "computer_middle_click",
    description: "Middle-click at a coordinate.",
    command: "middle_click",
    destructive: true,
    properties: { coordinate: COORD, displayId: DISPLAY },
    required: ["coordinate"],
  },
  {
    name: "computer_mouse_move",
    description: "Move the cursor to a coordinate.",
    command: "mouse_move",
    destructive: true,
    properties: { coordinate: COORD, displayId: DISPLAY },
    required: ["coordinate"],
  },
  {
    name: "computer_mouse_down",
    description: "Press and hold the left button at a coordinate.",
    command: "mouse_down",
    destructive: true,
    properties: { coordinate: COORD, displayId: DISPLAY },
    required: ["coordinate"],
  },
  {
    name: "computer_mouse_up",
    description: "Release the held left button (optionally at a coordinate).",
    command: "mouse_up",
    destructive: true,
    properties: { coordinate: COORD, displayId: DISPLAY },
  },
  {
    name: "computer_type",
    description: "Type text at the current focus.",
    command: "type",
    destructive: true,
    properties: { text: { type: "string", description: "Text to type." } },
    required: ["text"],
  },
  {
    name: "computer_key",
    description: "Press a single key (e.g. Return, Tab, F5).",
    command: "key_press",
    destructive: true,
    properties: { key: { type: "string", description: "Key name." } },
    required: ["key"],
  },
  {
    name: "computer_key_combo",
    description: "Press a key combination (e.g. ctrl+c).",
    command: "key_combo",
    destructive: true,
    properties: { key: { type: "string", description: "Combo, e.g. ctrl+c." } },
    required: ["key"],
  },
  {
    name: "computer_key_down",
    description: "Press and hold a key (incl. modifiers).",
    command: "key_down",
    destructive: true,
    properties: { key: { type: "string", description: "Key name." } },
    required: ["key"],
  },
  {
    name: "computer_key_up",
    description: "Release a held key.",
    command: "key_up",
    destructive: true,
    properties: { key: { type: "string", description: "Key name." } },
    required: ["key"],
  },
  {
    name: "computer_scroll",
    description: "Scroll at a coordinate.",
    command: "scroll",
    destructive: true,
    properties: {
      coordinate: COORD,
      displayId: DISPLAY,
      scrollDirection: {
        type: "string",
        description: "up | down | left | right",
      },
      scrollAmount: { type: "number", description: "Notch count." },
    },
    required: ["coordinate"],
  },
  {
    name: "computer_drag",
    description: "Drag from start to end (or along a multi-point path).",
    command: "drag",
    destructive: true,
    properties: {
      startCoordinate: COORD,
      coordinate: COORD,
      displayId: DISPLAY,
    },
  },
  {
    name: "computer_set_value",
    description:
      "Set the value of the UI element at a coordinate (a11y write).",
    command: "set_value",
    destructive: true,
    properties: {
      coordinate: COORD,
      displayId: DISPLAY,
      text: { type: "string", description: "Value to set." },
    },
    required: ["coordinate", "text"],
  },
  {
    name: "computer_open",
    description: "Open a file / URL / folder with the OS default handler.",
    command: "open",
    destructive: true,
    properties: { target: { type: "string", description: "Path or URL." } },
    required: ["target"],
  },
  {
    name: "computer_launch",
    description: "Launch an application; returns its pid.",
    command: "launch",
    destructive: true,
    properties: {
      app: { type: "string", description: "Executable name/path." },
      appArgs: {
        type: "array",
        description: "Arguments.",
        items: { type: "string" },
      },
    },
    required: ["app"],
  },
  {
    name: "computer_kill_app",
    description: "Terminate a process by pid or name.",
    command: "kill_app",
    destructive: true,
    properties: {
      target: { type: "string", description: "pid or process name." },
    },
    required: ["target"],
  },
] as const;

/** Look up a tool by its MCP name. */
export function findComputerUseMcpTool(
  name: string,
): ComputerUseMcpTool | undefined {
  return COMPUTERUSE_MCP_TOOLS.find((t) => t.name === name);
}

/**
 * Dispatch an MCP tool call to the computer-use service. Pure routing:
 * resolves the tool → `executeCommand(tool.command, args)`. Throws on an unknown
 * tool name. The service applies the approval policy + returns a DTO.
 */
export async function dispatchComputerUseMcpTool(
  runner: ComputerUseCommandRunner,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<ComputerUseResult> {
  const tool = findComputerUseMcpTool(toolName);
  if (!tool) {
    throw new Error(`Unknown computer-use MCP tool: ${toolName}`);
  }
  return runner.executeCommand(tool.command, args);
}
