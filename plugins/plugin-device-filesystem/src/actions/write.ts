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
import {
  ENCODING_SCHEMA,
  describeZodError,
  emit,
  failure,
} from "./_shared.js";

const WRITE_SCHEMA = z.object({
  path: z.string().min(1, "path is required"),
  content: z.string(),
  encoding: ENCODING_SCHEMA.optional(),
});

export const deviceFileWriteAction: Action = {
  name: "DEVICE_FILE_WRITE",
  similes: ["WRITE_DEVICE_FILE", "DEVICE_WRITE_FILE"],
  description:
    "Write a file to the user's device. On iOS/Android this writes into Capacitor's Documents directory (visible in Files.app / shared storage); on desktop/AOSP it writes under the agent's workspace in the state directory. Paths are relative; `..` traversal and absolute paths are rejected.",
  descriptionCompressed:
    "write file to device (relative path, utf8|base64 content)",
  parameters: [
    {
      name: "path",
      description: "Relative path within the user's device-files root.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "content",
      description: "File content as a string. base64-encode when binary.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "encoding",
      description:
        "How the content string should be interpreted. Defaults to utf8.",
      required: false,
      schema: { type: "string" as const, enum: ["utf8", "base64"] },
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
    const parsed = WRITE_SCHEMA.safeParse(raw);
    if (!parsed.success) {
      return failure("invalid_param", describeZodError(parsed.error));
    }
    const { path, content, encoding } = parsed.data;
    const bridge = getDeviceFilesystemBridge(runtime);
    await bridge.write(path, content, encoding ?? "utf8");
    const bytes = Buffer.byteLength(content, encoding ?? "utf8");
    const text = `Wrote ${bytes} byte${bytes === 1 ? "" : "s"} to ${path}`;
    await emit(callback, text);
    return {
      success: true,
      text,
      data: {
        action: "DEVICE_FILE_WRITE",
        path,
        encoding: encoding ?? "utf8",
        bytes,
      },
    };
  },
};
