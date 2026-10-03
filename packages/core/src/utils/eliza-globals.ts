/** API connection accessors backed by the shared boot-config store. */
import { getBootConfig, setBootConfig } from "../config/boot-config-store.js";

function readTrimmedString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function getElizaApiBase(): string | undefined {
	return readTrimmedString(getBootConfig().apiBase);
}

export function getElizaApiToken(): string | undefined {
	return readTrimmedString(getBootConfig().apiToken);
}

export function setElizaApiBase(value: string): void {
	const apiBase = readTrimmedString(value);
	setBootConfig({ ...getBootConfig(), apiBase });
}

export function clearElizaApiBase(): void {
	const { apiBase: _apiBase, ...config } = getBootConfig();
	setBootConfig(config);
}

export function setElizaApiToken(value: string): void {
	setBootConfig({ ...getBootConfig(), apiToken: readTrimmedString(value) });
}

export function clearElizaApiToken(): void {
	const { apiToken: _apiToken, ...config } = getBootConfig();
	setBootConfig(config);
}
