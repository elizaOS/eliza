/**
 * CLIPBOARD parent action — read or write the host system clipboard.
 *
 * Routes through `driverReadClipboard` / `driverWriteClipboard`, which
 * select the per-OS tool (pbcopy/pbpaste, wl-copy/wl-paste, xclip,
 * PowerShell Set-Clipboard / Get-Clipboard).
 *
 * Subactions: `read`, `write`. The plugin index promotes them to virtual
 * top-level actions (`CLIPBOARD_READ`, `CLIPBOARD_WRITE`) so the planner
 * can pick a specific verb directly from the action catalogue.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  ClipboardUnavailableError,
  readClipboard as driverReadClipboard,
  writeClipboard as driverWriteClipboard,
} from "../platform/clipboard.js";
import type { ComputerUseService } from "../services/computer-use-service.js";
import { resolveActionParams, toComputerUseActionResult } from "./helpers.js";

const CLIPBOARD_ACTIONS = ["read", "write"] as const;
export type ClipboardActionType = (typeof CLIPBOARD_ACTIONS)[number];

export interface ClipboardActionParams {
  action: ClipboardActionType;
  /** Text payload for `write`. Ignored for `read`. */
  text?: string;
}

interface ClipboardActionResult {
  success: boolean;
  message?: string;
  error?: string;
  /** Populated for `read` on success. */
  text?: string;
}

type ClipboardParameters = Omit<Partial<ClipboardActionParams>, "action"> & {
  action?: ClipboardActionType | string;
  subaction?: ClipboardActionType | string;
  op?: ClipboardActionType | string;
};

const CLIPBOARD_PREVIEW_BYTES = 4096;

function getComputerUseService(
  runtime: IAgentRuntime,
): ComputerUseService | null {
  return (runtime.getService("computeruse") as ComputerUseService) ?? null;
}

function normalizeClipboardToken(value: unknown): ClipboardActionType | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if ((CLIPBOARD_ACTIONS as readonly string[]).includes(normalized)) {
    return normalized as ClipboardActionType;
  }
  return undefined;
}

function resolveClipboardAction(
  params: ClipboardParameters,
): ClipboardActionType | undefined {
  return (
    normalizeClipboardToken(params.action) ??
    normalizeClipboardToken(params.subaction) ??
    normalizeClipboardToken(params.op)
  );
}

async function runClipboardAction(
  params: ClipboardActionParams,
): Promise<ClipboardActionResult> {
  if (params.action === "read") {
    const text = await driverReadClipboard();
    const preview =
      text.length > CLIPBOARD_PREVIEW_BYTES
        ? `${text.slice(0, CLIPBOARD_PREVIEW_BYTES)}…`
        : text;
    return {
      success: true,
      text,
      message: text.length === 0 ? "Clipboard is empty." : preview,
    };
  }
  if (params.action === "write") {
    if (typeof params.text !== "string") {
      return {
        success: false,
        error: "text is required for clipboard write",
      };
    }
    await driverWriteClipboard(params.text);
    return {
      success: true,
      message: `Wrote ${Buffer.byteLength(params.text, "utf-8")} bytes to clipboard.`,
    };
  }
  return {
    success: false,
    error: `Unknown clipboard action: ${(params as { action: string }).action}`,
  };
}

export const clipboardAction: Action = {
  name: "CLIPBOARD",
  contexts: ["screen_time", "automation", "files"],
  contextGate: {
    anyOf: ["screen_time", "automation", "files"],
  },
  roleGate: { minRole: "USER" },
  similes: [
    "USE_CLIPBOARD",
    "CLIPBOARD_ACTION",
    "COPY",
    "PASTE",
    "READ_CLIPBOARD",
    "WRITE_CLIPBOARD",
  ],
  description:
    "CLIPBOARD action. Read or write the host system clipboard. actions: read, write. Linux requires wl-clipboard (Wayland) or xclip (X11); macOS uses pbcopy/pbpaste; Windows uses PowerShell Set-Clipboard / Get-Clipboard.",
  descriptionCompressed: "CLIPBOARD action=read|write",
  parameters: [
    {
      name: "action",
      description: "Clipboard operation verb.",
      required: true,
      schema: {
        type: "string",
        enum: [...CLIPBOARD_ACTIONS],
      },
    },
    {
      name: "text",
      description: "Payload for write.",
      required: false,
      schema: { type: "string" },
    },
  ],
  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const service = getComputerUseService(runtime);
    if (!service) return false;
    return service.getCapabilities().clipboard.available;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service = getComputerUseService(runtime);
    if (!service) {
      return { success: false, error: "ComputerUseService not available" };
    }

    const params = resolveActionParams<ClipboardParameters>(message, options);
    const action = resolveClipboardAction(params) ?? "read";

    let result: ClipboardActionResult;
    try {
      result = await runClipboardAction({ ...params, action } satisfies ClipboardActionParams);
    } catch (error) {
      const message =
        error instanceof ClipboardUnavailableError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      result = { success: false, error: message };
    }

    const text = result.success
      ? (result.message ?? `Completed clipboard ${action}.`)
      : `Clipboard action failed: ${result.error}`;

    if (callback) {
      await callback({ text });
    }

    return toComputerUseActionResult({
      action,
      result,
      text,
      // CLIPBOARD_READ deliberately surfaces text in the action result; do not
      // strip it via the shared clipboard suppression flag.
      suppressClipboard: action === "write",
    });
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "What's currently on my clipboard?", source: "chat" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Reading the clipboard.",
          actions: ["CLIPBOARD"],
          thought:
            "Clipboard inspection routes to CLIPBOARD action=read; the result text contains the payload.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Copy 'meeting at 3pm' to my clipboard.",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Writing the text to the clipboard.",
          actions: ["CLIPBOARD"],
          thought:
            "Putting a literal string on the clipboard maps to CLIPBOARD action=write with the payload in `text`.",
        },
      },
    ],
  ],
};
