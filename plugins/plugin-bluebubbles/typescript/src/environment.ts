/**
 * Environment and configuration validation for BlueBubbles plugin
 */

import type { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";
import type { BlueBubblesConfig, DmPolicy, GroupPolicy } from "./types";

const DmPolicySchema = z.enum(["open", "pairing", "allowlist", "disabled"]);
const GroupPolicySchema = z.enum(["open", "allowlist", "disabled"]);

export const BlueBubblesConfigSchema = z.object({
	serverUrl: z.string().url("Server URL must be a valid URL"),
	password: z.string().min(1, "Password is required"),
	webhookPath: z.string().optional().default("/webhooks/bluebubbles"),
	autoStartCommand: z.string().optional(),
	autoStartArgs: z.array(z.string()).optional().default([]),
	autoStartCwd: z.string().optional(),
	autoStartWaitMs: z.number().int().nonnegative().optional().default(15000),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	allowFrom: z.array(z.string()).optional().default([]),
	groupAllowFrom: z.array(z.string()).optional().default([]),
	sendReadReceipts: z.boolean().optional().default(true),
	enabled: z.boolean().optional().default(true),
});

export type ValidatedBlueBubblesConfig = z.infer<
	typeof BlueBubblesConfigSchema
>;

/**
 * Validates BlueBubbles configuration
 */
export function validateConfig(
	config: Partial<BlueBubblesConfig>,
): ValidatedBlueBubblesConfig {
	return BlueBubblesConfigSchema.parse(config);
}

/**
 * Gets BlueBubbles configuration from runtime settings
 */
export function getConfigFromRuntime(
	runtime: IAgentRuntime,
): BlueBubblesConfig | null {
	// Helper to safely get string settings
	const getStringSetting = (key: string): string | undefined => {
		const value = runtime.getSetting(key);
		return typeof value === "string" ? value : undefined;
	};

	const serverUrl = getStringSetting("BLUEBUBBLES_SERVER_URL");
	const password = getStringSetting("BLUEBUBBLES_PASSWORD");

	if (!serverUrl || !password) {
		return null;
	}

	const allowFromRaw = getStringSetting("BLUEBUBBLES_ALLOW_FROM");
	const groupAllowFromRaw = getStringSetting("BLUEBUBBLES_GROUP_ALLOW_FROM");
	const autoStartArgsRaw = getStringSetting("BLUEBUBBLES_AUTOSTART_ARGS");
	const autoStartWaitMsRaw = getStringSetting("BLUEBUBBLES_AUTOSTART_WAIT_MS");

	const parseAllowList = (raw: string | undefined): string[] => {
		if (!raw) return [];
		return raw
			.split(",")
			.map((s: string) => s.trim())
			.filter(Boolean);
	};

	const parseStringList = (raw: string | undefined): string[] => {
		if (!raw) return [];
		const trimmed = raw.trim();
		if (!trimmed) return [];

		if (trimmed.startsWith("[")) {
			try {
				const parsed = JSON.parse(trimmed);
				if (Array.isArray(parsed)) {
					return parsed
						.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
						.filter(Boolean);
				}
			} catch {
				// Fall back to comma-separated parsing below.
			}
		}

		return trimmed
			.split(",")
			.map((s: string) => s.trim())
			.filter(Boolean);
	};

	const parseNonNegativeInt = (
		raw: string | undefined,
		fallback: number,
	): number => {
		if (!raw) return fallback;
		const parsed = Number.parseInt(raw, 10);
		if (!Number.isFinite(parsed) || parsed < 0) {
			return fallback;
		}
		return parsed;
	};

	return {
		serverUrl,
		password,
		webhookPath:
			getStringSetting("BLUEBUBBLES_WEBHOOK_PATH") ?? "/webhooks/bluebubbles",
		autoStartCommand: getStringSetting("BLUEBUBBLES_AUTOSTART_COMMAND"),
		autoStartArgs: parseStringList(autoStartArgsRaw),
		autoStartCwd: getStringSetting("BLUEBUBBLES_AUTOSTART_CWD"),
		autoStartWaitMs: parseNonNegativeInt(autoStartWaitMsRaw, 15000),
		dmPolicy:
			(getStringSetting("BLUEBUBBLES_DM_POLICY") as DmPolicy) ?? "pairing",
		groupPolicy:
			(getStringSetting("BLUEBUBBLES_GROUP_POLICY") as GroupPolicy) ??
			"allowlist",
		allowFrom: parseAllowList(allowFromRaw),
		groupAllowFrom: parseAllowList(groupAllowFromRaw),
		sendReadReceipts:
			getStringSetting("BLUEBUBBLES_SEND_READ_RECEIPTS") !== "false",
		enabled: getStringSetting("BLUEBUBBLES_ENABLED") !== "false",
	};
}

/**
 * Normalizes a phone number or email handle
 */
export function normalizeHandle(handle: string): string {
	const trimmed = handle.trim();

	// If it looks like an email, lowercase it
	if (trimmed.includes("@") && !trimmed.startsWith("+")) {
		return trimmed.toLowerCase();
	}

	// For phone numbers, strip non-digits except leading +
	const startsWithPlus = trimmed.startsWith("+");
	const digits = trimmed.replace(/\D/g, "");

	// Add + prefix if it was there or if we have 10+ digits (assume international)
	if (startsWithPlus || digits.length >= 10) {
		return `+${digits}`;
	}

	return digits;
}

/**
 * Checks if a handle is in the allow list
 */
export function isHandleAllowed(
	handle: string,
	allowList: string[],
	policy: DmPolicy | GroupPolicy,
): boolean {
	if (policy === "open") {
		return true;
	}

	if (policy === "disabled") {
		return false;
	}

	if (policy === "pairing" || policy === "allowlist") {
		if (allowList.length === 0 && policy === "pairing") {
			// Pairing mode with empty allow list allows first contact
			return true;
		}

		const normalizedHandle = normalizeHandle(handle);
		return allowList.some(
			(allowed) => normalizeHandle(allowed) === normalizedHandle,
		);
	}

	return false;
}
