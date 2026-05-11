import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import { z } from "zod";

import {
  DeviceFilesystemBridge,
  getDeviceFilesystemBridge,
} from "../services/device-filesystem-bridge.js";
import type { DirectoryEntry } from "../types.js";
import { describeZodError, emit, failure } from "./_shared.js";

const LIST_SCHEMA = z.object({
  path: z.string().default(""),
});

function renderEntries(path: string, entries: DirectoryEntry[]): string {
  if (entries.length === 0) {
    return `(${path || "."}: empty)`;
  }
  const lines = entries
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) =>
      entry.type === "directory" ? `${entry.name}/` : entry.name,
    );
  return `${path || "."}:\n${lines.join("\n")}`;
}

export const deviceListDirAction: Action = {
  name: "DEVICE_LIST_DIR",
  similes: ["LIST_DEVICE_DIR", "DEVICE_LS"],
  description:
    "List entries in a directory on the user's device. On iOS/Android this lists inside Capacitor's Documents directory; on desktop/AOSP it lists under the agent's workspace in the state directory. Paths are relative; `..` traversal and absolute paths are rejected.",
  descriptionCompressed:
    "list directory on device (relative path; rooted under Documents/workspace)",
  parameters: [
    {
      name: "path",
      description:
        "Relative directory path within the user's device-files root. Empty string or omitted means the root.",
      required: false,
      schema: { type: "string" as const },
    },
  ],
  validate: async (runtime: IAgentRuntime) =>
    Boolean(
      runtime.getService<DeviceFilesystemBridge>(
        DeviceFilesystemBridge.serviceType,
      ),
    ),
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const raw: unknown = options?.parameters ?? {};
    const parsed = LIST_SCHEMA.safeParse(raw);
    if (!parsed.success) {
      return failure("invalid_param", describeZodError(parsed.error));
    }
    const { path } = parsed.data;
    const bridge = getDeviceFilesystemBridge(runtime);
    const entries = await bridge.list(path);
    const text = renderEntries(path, entries);
    await emit(callback, text);
    return {
      success: true,
      text,
      data: {
        action: "DEVICE_LIST_DIR",
        path,
        entries,
      },
    };
  },
};
