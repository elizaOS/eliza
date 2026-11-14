import { AgentNotReadyError } from "./config-and-auth-rpc";
import { isRecord } from "./rpc-parse-utils";
import type {
	AgentAutomationMode,
	AgentAutomationModeSnapshot,
	SettingsConfigSnapshot,
	TradePermissionMode,
	TradePermissionModeSnapshot,
} from "./rpc-schema";

const DEFAULT_TIMEOUT_MS = 8_000;

function isAgentAutomationMode(value: unknown): value is AgentAutomationMode {
	return value === "connectors-only" || value === "full";
}

function isTradePermissionMode(value: unknown): value is TradePermissionMode {
	return (
		value === "user-sign-only" ||
		value === "manual-local-key" ||
		value === "agent-auto" ||
		value === "disabled"
	);
}

function parseConfigSnapshot(body: unknown): SettingsConfigSnapshot | null {
	return isRecord(body) ? body : null;
}

function parseAgentAutomationModeSnapshot(
	body: unknown,
): AgentAutomationModeSnapshot | null {
	if (!isRecord(body) || !isAgentAutomationMode(body.mode)) return null;
	if (!Array.isArray(body.options)) return null;
	const options: AgentAutomationMode[] = [];
	for (const option of body.options) {
		if (!isAgentAutomationMode(option)) return null;
		options.push(option);
	}
	return { mode: body.mode, options };
}

function parseTradePermissionModeSnapshot(
	body: unknown,
): TradePermissionModeSnapshot | null {
	if (!isRecord(body)) return null;
	const mode = body.tradePermissionMode ?? body.mode;
	if (!isTradePermissionMode(mode)) return null;
	const canUserLocalExecute =
		typeof body.canUserLocalExecute === "boolean"
			? body.canUserLocalExecute
			: undefined;
	const canAgentAutoTrade =
		typeof body.canAgentAutoTrade === "boolean"
			? body.canAgentAutoTrade
			: undefined;
	const ok = typeof body.ok === "boolean" ? body.ok : undefined;
	const options = Array.isArray(body.options)
		? body.options.filter(isTradePermissionMode)
		: undefined;
	return {
		...(ok === undefined ? {} : { ok }),
		mode,
		tradePermissionMode: mode,
		...(options === undefined ? {} : { options }),
		...(canUserLocalExecute === undefined ? {} : { canUserLocalExecute }),
		...(canAgentAutoTrade === undefined ? {} : { canAgentAutoTrade }),
	};
}

async function sendJson<T>(
	port: number,
	method: "GET" | "PUT",
	pathname: string,
	body: unknown,
	parse: (value: unknown) => T | null,
): Promise<T | null> {
	try {
		const init: RequestInit = {
			method,
			signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
		};
		if (body !== undefined) {
			init.headers = { "Content-Type": "application/json" };
			init.body = JSON.stringify(body);
		}
		const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
			...init,
		});
		if (!response.ok) return null;
		return parse(await response.json());
	} catch {
		return null;
	}
}

export type ConfigUpdateWriter = (
	port: number,
	patch: SettingsConfigSnapshot,
) => Promise<SettingsConfigSnapshot | null>;

export type AgentAutomationModeReader = (
	port: number,
) => Promise<AgentAutomationModeSnapshot | null>;

export type AgentAutomationModeWriter = (
	port: number,
	mode: AgentAutomationMode,
) => Promise<AgentAutomationModeSnapshot | null>;

export type TradePermissionModeReader = (
	port: number,
) => Promise<TradePermissionModeSnapshot | null>;

export type TradePermissionModeWriter = (
	port: number,
	mode: TradePermissionMode,
) => Promise<TradePermissionModeSnapshot | null>;

export const updateConfigViaHttp: ConfigUpdateWriter = (port, patch) =>
	sendJson(port, "PUT", "/api/config", patch, parseConfigSnapshot);

export const readAgentAutomationModeViaHttp: AgentAutomationModeReader = (
	port,
) =>
	sendJson(
		port,
		"GET",
		"/api/permissions/automation-mode",
		undefined,
		parseAgentAutomationModeSnapshot,
	);

export const updateAgentAutomationModeViaHttp: AgentAutomationModeWriter = (
	port,
	mode,
) =>
	sendJson(
		port,
		"PUT",
		"/api/permissions/automation-mode",
		{ mode },
		parseAgentAutomationModeSnapshot,
	);

export const readTradePermissionModeViaHttp: TradePermissionModeReader = (
	port,
) =>
	sendJson(
		port,
		"GET",
		"/api/permissions/trade-mode",
		undefined,
		parseTradePermissionModeSnapshot,
	);

export const updateTradePermissionModeViaHttp: TradePermissionModeWriter = (
	port,
	mode,
) =>
	sendJson(
		port,
		"PUT",
		"/api/permissions/trade-mode",
		{ mode },
		parseTradePermissionModeSnapshot,
	);

export async function composeConfigUpdate(
	port: number | null,
	patch: SettingsConfigSnapshot,
	write: ConfigUpdateWriter,
): Promise<SettingsConfigSnapshot> {
	if (port === null) throw new AgentNotReadyError("updateConfig");
	const value = await write(port, patch);
	if (value === null) throw new AgentNotReadyError("updateConfig");
	return value;
}

export async function composeAgentAutomationModeSnapshot(
	port: number | null,
	read: AgentAutomationModeReader,
): Promise<AgentAutomationModeSnapshot> {
	if (port === null) throw new AgentNotReadyError("getAgentAutomationMode");
	const value = await read(port);
	if (value === null) throw new AgentNotReadyError("getAgentAutomationMode");
	return value;
}

export async function composeAgentAutomationModeUpdate(
	port: number | null,
	mode: AgentAutomationMode,
	write: AgentAutomationModeWriter,
): Promise<AgentAutomationModeSnapshot> {
	if (port === null) throw new AgentNotReadyError("setAgentAutomationMode");
	const value = await write(port, mode);
	if (value === null) throw new AgentNotReadyError("setAgentAutomationMode");
	return value;
}

export async function composeTradePermissionModeSnapshot(
	port: number | null,
	read: TradePermissionModeReader,
): Promise<TradePermissionModeSnapshot> {
	if (port === null) throw new AgentNotReadyError("getTradePermissionMode");
	const value = await read(port);
	if (value === null) throw new AgentNotReadyError("getTradePermissionMode");
	return value;
}

export async function composeTradePermissionModeUpdate(
	port: number | null,
	mode: TradePermissionMode,
	write: TradePermissionModeWriter,
): Promise<TradePermissionModeSnapshot> {
	if (port === null) throw new AgentNotReadyError("setTradePermissionMode");
	const value = await write(port, mode);
	if (value === null) throw new AgentNotReadyError("setTradePermissionMode");
	return value;
}
