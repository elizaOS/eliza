import { AgentNotReadyError } from "./config-and-auth-rpc";
import type { ExtensionStatusSnapshot } from "./rpc-schema";

const DEFAULT_TIMEOUT_MS = 4_000;
const INVALID_OPTIONAL_FIELD = Symbol("invalid optional field");
type OptionalField<T> = T | undefined | typeof INVALID_OPTIONAL_FIELD;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): string | null | undefined {
	if (value === null) return null;
	return typeof value === "string" ? value : undefined;
}

function optionalNullableString(
	body: Record<string, unknown>,
	key: string,
): OptionalField<string | null> {
	if (!(key in body)) return undefined;
	const value = nullableString(body[key]);
	return value === undefined ? INVALID_OPTIONAL_FIELD : value;
}

function optionalRecordOrNull(
	value: unknown,
): OptionalField<Record<string, unknown> | null> {
	if (value === undefined) return undefined;
	if (value === null) return null;
	return isRecord(value) ? value : INVALID_OPTIONAL_FIELD;
}

function parseExtensionStatusSnapshot(
	body: unknown,
): ExtensionStatusSnapshot | null {
	if (!isRecord(body)) return null;
	if (typeof body.relayReachable !== "boolean") return null;
	if (typeof body.relayPort !== "number" || !Number.isFinite(body.relayPort)) {
		return null;
	}

	const extensionPath = nullableString(body.extensionPath);
	if (extensionPath === undefined) return null;

	const chromeBuildPath = optionalNullableString(body, "chromeBuildPath");
	const chromePackagePath = optionalNullableString(body, "chromePackagePath");
	const safariWebExtensionPath = optionalNullableString(
		body,
		"safariWebExtensionPath",
	);
	const safariAppPath = optionalNullableString(body, "safariAppPath");
	const safariPackagePath = optionalNullableString(body, "safariPackagePath");
	const releaseManifest = optionalRecordOrNull(body.releaseManifest);

	if (
		chromeBuildPath === INVALID_OPTIONAL_FIELD ||
		chromePackagePath === INVALID_OPTIONAL_FIELD ||
		safariWebExtensionPath === INVALID_OPTIONAL_FIELD ||
		safariAppPath === INVALID_OPTIONAL_FIELD ||
		safariPackagePath === INVALID_OPTIONAL_FIELD ||
		releaseManifest === INVALID_OPTIONAL_FIELD
	) {
		return null;
	}

	return {
		relayReachable: body.relayReachable,
		relayPort: body.relayPort,
		extensionPath,
		...(chromeBuildPath === undefined ? {} : { chromeBuildPath }),
		...(chromePackagePath === undefined ? {} : { chromePackagePath }),
		...(safariWebExtensionPath === undefined ? {} : { safariWebExtensionPath }),
		...(safariAppPath === undefined ? {} : { safariAppPath }),
		...(safariPackagePath === undefined ? {} : { safariPackagePath }),
		...(releaseManifest === undefined ? {} : { releaseManifest }),
	};
}

export type ExtensionStatusReader = (
	port: number,
) => Promise<ExtensionStatusSnapshot | null>;

export const readExtensionStatusViaHttp: ExtensionStatusReader = async (
	port,
) => {
	try {
		const response = await fetch(
			`http://127.0.0.1:${port}/api/extension/status`,
			{
				method: "GET",
				signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
			},
		);
		if (!response.ok) return null;
		return parseExtensionStatusSnapshot(await response.json());
	} catch {
		return null;
	}
};

export async function composeExtensionStatusSnapshot(
	port: number | null,
	read: ExtensionStatusReader,
): Promise<ExtensionStatusSnapshot> {
	if (port === null) throw new AgentNotReadyError("getExtensionStatus");
	const value = await read(port);
	if (value === null) throw new AgentNotReadyError("getExtensionStatus");
	return value;
}
