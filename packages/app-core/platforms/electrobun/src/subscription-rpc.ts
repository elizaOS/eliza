import type {
	SubscriptionProviderStatus,
	SubscriptionStatusResponse,
} from "@elizaos/shared";
import { AgentNotReadyError } from "./config-and-auth-rpc";

const DEFAULT_TIMEOUT_MS = 4_000;

const SUBSCRIPTION_CREDENTIAL_SOURCES = [
	"app",
	"claude-code-cli",
	"setup-token",
	"codex-cli",
	"gemini-cli",
	"coding-plan-key",
	"unavailable",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSubscriptionCredentialSource(
	value: unknown,
): value is SubscriptionProviderStatus["source"] {
	if (value === null) return true;
	return (
		typeof value === "string" &&
		SUBSCRIPTION_CREDENTIAL_SOURCES.some((source) => source === value)
	);
}

function optionalString(
	body: Record<string, unknown>,
	key: string,
): string | undefined | false {
	if (!(key in body)) return undefined;
	const value = body[key];
	return typeof value === "string" ? value : false;
}

function optionalBoolean(
	body: Record<string, unknown>,
	key: string,
): boolean | undefined | false {
	if (!(key in body)) return undefined;
	const value = body[key];
	return typeof value === "boolean" ? value : false;
}

function parseExpiresAt(value: unknown): number | null | false {
	if (value === null) return null;
	return typeof value === "number" && Number.isFinite(value) ? value : false;
}

function parseSubscriptionProviderStatus(
	value: unknown,
): SubscriptionProviderStatus | null {
	if (!isRecord(value)) return null;
	if (typeof value.provider !== "string") return null;
	if (typeof value.accountId !== "string") return null;
	if (typeof value.label !== "string") return null;
	if (typeof value.configured !== "boolean") return null;
	if (typeof value.valid !== "boolean") return null;
	if (!isSubscriptionCredentialSource(value.source)) return null;

	const expiresAt = parseExpiresAt(value.expiresAt);
	if (expiresAt === false) return null;

	const available = optionalBoolean(value, "available");
	const availabilityReason = optionalString(value, "availabilityReason");
	const allowedClient = optionalString(value, "allowedClient");
	const loginHint = optionalString(value, "loginHint");
	const billingMode = optionalString(value, "billingMode");
	if (
		available === false ||
		availabilityReason === false ||
		allowedClient === false ||
		loginHint === false ||
		(billingMode !== undefined &&
			billingMode !== "subscription-coding-plan" &&
			billingMode !== "subscription-coding-cli")
	) {
		return null;
	}

	return {
		provider: value.provider,
		accountId: value.accountId,
		label: value.label,
		configured: value.configured,
		valid: value.valid,
		expiresAt,
		source: value.source,
		...(available === undefined ? {} : { available }),
		...(availabilityReason === undefined ? {} : { availabilityReason }),
		...(allowedClient === undefined ? {} : { allowedClient }),
		...(loginHint === undefined ? {} : { loginHint }),
		...(billingMode === undefined ? {} : { billingMode }),
	};
}

function parseSubscriptionStatusResponse(
	body: unknown,
): SubscriptionStatusResponse | null {
	if (!isRecord(body) || !Array.isArray(body.providers)) return null;
	const providers: SubscriptionProviderStatus[] = [];
	for (const entry of body.providers) {
		const parsed = parseSubscriptionProviderStatus(entry);
		if (parsed === null) return null;
		providers.push(parsed);
	}
	return { providers };
}

export type SubscriptionStatusReader = (
	port: number,
) => Promise<SubscriptionStatusResponse | null>;

export const readSubscriptionStatusViaHttp: SubscriptionStatusReader = async (
	port,
) => {
	try {
		const response = await fetch(
			`http://127.0.0.1:${port}/api/subscription/status`,
			{
				method: "GET",
				signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
			},
		);
		if (!response.ok) return null;
		return parseSubscriptionStatusResponse(await response.json());
	} catch {
		return null;
	}
};

export async function composeSubscriptionStatusSnapshot(
	port: number | null,
	read: SubscriptionStatusReader,
): Promise<SubscriptionStatusResponse> {
	if (port === null) throw new AgentNotReadyError("getSubscriptionStatus");
	const value = await read(port);
	if (value === null) throw new AgentNotReadyError("getSubscriptionStatus");
	return value;
}
