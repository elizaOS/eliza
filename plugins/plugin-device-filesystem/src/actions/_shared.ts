import type { ActionResult, HandlerCallback } from "@elizaos/core";
import { z } from "zod";

import { DEVICE_FILESYSTEM_LOG_PREFIX } from "../types.js";

export const ENCODING_SCHEMA = z.enum(["utf8", "base64"]);

export function failure(reason: string, message: string): ActionResult {
	const text = `${DEVICE_FILESYSTEM_LOG_PREFIX} ${reason}: ${message}`;
	return { success: false, text, error: new Error(text) };
}

export async function emit(
	callback: HandlerCallback | undefined,
	text: string,
): Promise<void> {
	if (callback) {
		await callback({ text, source: "device-filesystem" });
	}
}

export function describeZodError(err: z.ZodError): string {
	return err.issues
		.map((issue) => {
			const path = issue.path.join(".");
			return path ? `${path}: ${issue.message}` : issue.message;
		})
		.join("; ");
}
