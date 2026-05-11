import type {
	Action,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "@elizaos/core";
import { z } from "zod";

import {
	DeviceFilesystemBridge,
	getDeviceFilesystemBridge,
} from "../services/device-filesystem-bridge.js";
import { describeZodError, ENCODING_SCHEMA, emit, failure } from "./_shared.js";

const READ_SCHEMA = z.object({
	path: z.string().min(1, "path is required"),
	encoding: ENCODING_SCHEMA.optional(),
});

export const deviceFileReadAction: Action = {
	name: "DEVICE_FILE_READ",
	similes: ["READ_DEVICE_FILE", "DEVICE_READ_FILE"],
	description:
		"Read a file from the user's device. On iOS/Android this reads from Capacitor's Documents directory; on desktop/AOSP it reads from the agent's workspace under the state directory. Paths are relative; `..` traversal and absolute paths are rejected.",
	descriptionCompressed:
		"read file from device (relative path, utf8|base64 encoding)",
	parameters: [
		{
			name: "path",
			description: "Relative path within the user's device-files root.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "encoding",
			description: "Text encoding to decode the bytes with. Defaults to utf8.",
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
		const parsed = READ_SCHEMA.safeParse(raw);
		if (!parsed.success) {
			return failure("invalid_param", describeZodError(parsed.error));
		}
		const { path, encoding } = parsed.data;
		const bridge = getDeviceFilesystemBridge(runtime);
		const data = await bridge.read(path, encoding ?? "utf8");
		const bytes = Buffer.byteLength(data, encoding ?? "utf8");
		const text = `Read ${bytes} byte${bytes === 1 ? "" : "s"} from ${path}`;
		await emit(callback, text);
		return {
			success: true,
			text,
			data: {
				action: "DEVICE_FILE_READ",
				path,
				encoding: encoding ?? "utf8",
				bytes,
				content: data,
			},
		};
	},
};
