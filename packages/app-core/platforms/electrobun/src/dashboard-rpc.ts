import { AgentNotReadyError } from "./config-and-auth-rpc";
import {
	finiteNumber,
	hasBooleanFields,
	isRecord,
	nullableString,
	optionalFiniteNumber,
	optionalString,
} from "./rpc-parse-utils";
import type {
	AgentSelfStatusSnapshot,
	CorePluginEntry,
	CorePluginsSnapshot,
	TriggerHealthSnapshot,
} from "./rpc-schema";

const DEFAULT_TIMEOUT_MS = 4_000;

function parseStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const output: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") return null;
		output.push(entry);
	}
	return output;
}

function isAgentState(
	value: unknown,
): value is AgentSelfStatusSnapshot["state"] {
	return (
		value === "not_started" ||
		value === "starting" ||
		value === "running" ||
		value === "stopped" ||
		value === "restarting" ||
		value === "error"
	);
}

function isAgentAutomationMode(
	value: unknown,
): value is AgentSelfStatusSnapshot["automationMode"] {
	return value === "connectors-only" || value === "full";
}

function isTradePermissionMode(
	value: unknown,
): value is AgentSelfStatusSnapshot["tradePermissionMode"] {
	return (
		value === "user-sign-only" ||
		value === "manual-local-key" ||
		value === "agent-auto" ||
		value === "disabled"
	);
}

function isWalletSource(
	value: unknown,
): value is AgentSelfStatusSnapshot["wallet"]["walletSource"] {
	return value === "local" || value === "managed" || value === "none";
}

const AGENT_WALLET_BOOLEAN_FIELDS = [
	"hasWallet",
	"hasEvm",
	"hasSolana",
	"localSignerAvailable",
	"managedBscRpcReady",
	"rpcReady",
	"pluginEvmLoaded",
	"pluginEvmRequired",
	"executionReady",
] as const;

const AGENT_CAPABILITY_BOOLEAN_FIELDS = [
	"canTrade",
	"canLocalTrade",
	"canAutoTrade",
	"canUseBrowser",
	"canUseComputer",
	"canRunTerminal",
	"canInstallPlugins",
	"canConfigurePlugins",
	"canConfigureConnectors",
] as const;

function parseAgentWallet(
	value: unknown,
): AgentSelfStatusSnapshot["wallet"] | null {
	if (!isRecord(value)) return null;
	if (!isWalletSource(value.walletSource)) return null;
	if (!hasBooleanFields(value, AGENT_WALLET_BOOLEAN_FIELDS)) return null;
	const evmAddress = nullableString(value.evmAddress);
	const evmAddressShort = nullableString(value.evmAddressShort);
	const solanaAddress = nullableString(value.solanaAddress);
	const solanaAddressShort = nullableString(value.solanaAddressShort);
	const executionBlockedReason = nullableString(value.executionBlockedReason);
	if (
		evmAddress === undefined ||
		evmAddressShort === undefined ||
		solanaAddress === undefined ||
		solanaAddressShort === undefined ||
		executionBlockedReason === undefined
	) {
		return null;
	}
	return {
		walletSource: value.walletSource,
		evmAddress,
		evmAddressShort,
		solanaAddress,
		solanaAddressShort,
		hasWallet: value.hasWallet === true,
		hasEvm: value.hasEvm === true,
		hasSolana: value.hasSolana === true,
		localSignerAvailable: value.localSignerAvailable === true,
		managedBscRpcReady: value.managedBscRpcReady === true,
		rpcReady: value.rpcReady === true,
		pluginEvmLoaded: value.pluginEvmLoaded === true,
		pluginEvmRequired: value.pluginEvmRequired === true,
		executionReady: value.executionReady === true,
		executionBlockedReason,
	};
}

function parseAgentPlugins(
	value: unknown,
): AgentSelfStatusSnapshot["plugins"] | null {
	if (!isRecord(value)) return null;
	const active = parseStringArray(value.active);
	const aiProviders = parseStringArray(value.aiProviders);
	const connectors = parseStringArray(value.connectors);
	const totalActive = finiteNumber(value.totalActive);
	if (
		active === null ||
		aiProviders === null ||
		connectors === null ||
		totalActive === null
	) {
		return null;
	}
	return {
		totalActive,
		active,
		aiProviders,
		connectors,
	};
}

function parseAgentCapabilities(
	value: unknown,
): AgentSelfStatusSnapshot["capabilities"] | null {
	if (!isRecord(value)) return null;
	if (!hasBooleanFields(value, AGENT_CAPABILITY_BOOLEAN_FIELDS)) return null;
	return {
		canTrade: value.canTrade === true,
		canLocalTrade: value.canLocalTrade === true,
		canAutoTrade: value.canAutoTrade === true,
		canUseBrowser: value.canUseBrowser === true,
		canUseComputer: value.canUseComputer === true,
		canRunTerminal: value.canRunTerminal === true,
		canInstallPlugins: value.canInstallPlugins === true,
		canConfigurePlugins: value.canConfigurePlugins === true,
		canConfigureConnectors: value.canConfigureConnectors === true,
	};
}

function parseAgentSelfStatusSnapshot(
	body: unknown,
): AgentSelfStatusSnapshot | null {
	if (!isRecord(body)) return null;
	if (typeof body.generatedAt !== "string") return null;
	if (!isAgentState(body.state)) return null;
	if (typeof body.agentName !== "string") return null;
	const model = nullableString(body.model);
	const provider = nullableString(body.provider);
	if (model === undefined || provider === undefined) return null;
	if (!isAgentAutomationMode(body.automationMode)) return null;
	if (!isTradePermissionMode(body.tradePermissionMode)) return null;
	if (typeof body.shellEnabled !== "boolean") return null;
	const wallet = parseAgentWallet(body.wallet);
	if (wallet === null) return null;
	const plugins = parseAgentPlugins(body.plugins);
	if (plugins === null) return null;
	const capabilities = parseAgentCapabilities(body.capabilities);
	if (capabilities === null) return null;

	const registrySummary = optionalString(body.registrySummary);
	if (registrySummary === false) return null;

	return {
		generatedAt: body.generatedAt,
		state: body.state,
		agentName: body.agentName,
		model,
		provider,
		automationMode: body.automationMode,
		tradePermissionMode: body.tradePermissionMode,
		shellEnabled: body.shellEnabled,
		wallet,
		plugins,
		capabilities,
		...(registrySummary === undefined ? {} : { registrySummary }),
	};
}

function parseTriggerHealthSnapshot(
	body: unknown,
): TriggerHealthSnapshot | null {
	if (!isRecord(body)) return null;
	if (typeof body.triggersEnabled !== "boolean") return null;
	const activeTriggers = finiteNumber(body.activeTriggers);
	const disabledTriggers = finiteNumber(body.disabledTriggers);
	const totalExecutions = finiteNumber(body.totalExecutions);
	const totalFailures = finiteNumber(body.totalFailures);
	const totalSkipped = finiteNumber(body.totalSkipped);
	const lastExecutionAt = optionalFiniteNumber(body.lastExecutionAt);
	if (
		activeTriggers === null ||
		disabledTriggers === null ||
		totalExecutions === null ||
		totalFailures === null ||
		totalSkipped === null ||
		lastExecutionAt === false
	) {
		return null;
	}

	return {
		triggersEnabled: body.triggersEnabled,
		activeTriggers,
		disabledTriggers,
		totalExecutions,
		totalFailures,
		totalSkipped,
		...(lastExecutionAt === undefined ? {} : { lastExecutionAt }),
	};
}

function parseCorePluginEntry(value: unknown): CorePluginEntry | null {
	if (!isRecord(value)) return null;
	if (
		typeof value.npmName !== "string" ||
		typeof value.id !== "string" ||
		typeof value.name !== "string" ||
		typeof value.isCore !== "boolean" ||
		typeof value.loaded !== "boolean" ||
		typeof value.enabled !== "boolean"
	) {
		return null;
	}
	return {
		npmName: value.npmName,
		id: value.id,
		name: value.name,
		isCore: value.isCore,
		loaded: value.loaded,
		enabled: value.enabled,
	};
}

function parseCorePluginEntries(value: unknown): CorePluginEntry[] | null {
	if (!Array.isArray(value)) return null;
	const output: CorePluginEntry[] = [];
	for (const entry of value) {
		const parsed = parseCorePluginEntry(entry);
		if (parsed === null) return null;
		output.push(parsed);
	}
	return output;
}

function parseCorePluginsSnapshot(body: unknown): CorePluginsSnapshot | null {
	if (!isRecord(body)) return null;
	const core = parseCorePluginEntries(body.core);
	const optional = parseCorePluginEntries(body.optional);
	if (core === null || optional === null) return null;
	return { core, optional };
}

async function readJsonEndpoint<T>(
	port: number,
	path: string,
	parse: (body: unknown) => T | null,
): Promise<T | null> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}${path}`, {
			method: "GET",
			signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
		});
		if (!response.ok) return null;
		return parse(await response.json());
	} catch {
		return null;
	}
}

export type AgentSelfStatusReader = (
	port: number,
) => Promise<AgentSelfStatusSnapshot | null>;

export type TriggerHealthReader = (
	port: number,
) => Promise<TriggerHealthSnapshot | null>;

export type CorePluginsReader = (
	port: number,
) => Promise<CorePluginsSnapshot | null>;

export const readAgentSelfStatusViaHttp: AgentSelfStatusReader = (port) =>
	readJsonEndpoint(
		port,
		"/api/agent/self-status",
		parseAgentSelfStatusSnapshot,
	);

export const readTriggerHealthViaHttp: TriggerHealthReader = (port) =>
	readJsonEndpoint(port, "/api/triggers/health", parseTriggerHealthSnapshot);

export const readCorePluginsViaHttp: CorePluginsReader = (port) =>
	readJsonEndpoint(port, "/api/plugins/core", parseCorePluginsSnapshot);

export async function composeAgentSelfStatusSnapshot(
	port: number | null,
	read: AgentSelfStatusReader,
): Promise<AgentSelfStatusSnapshot> {
	if (port === null) throw new AgentNotReadyError("getAgentSelfStatus");
	const value = await read(port);
	if (value === null) throw new AgentNotReadyError("getAgentSelfStatus");
	return value;
}

export async function composeTriggerHealthSnapshot(
	port: number | null,
	read: TriggerHealthReader,
): Promise<TriggerHealthSnapshot> {
	if (port === null) throw new AgentNotReadyError("getTriggerHealth");
	const value = await read(port);
	if (value === null) throw new AgentNotReadyError("getTriggerHealth");
	return value;
}

export async function composeCorePluginsSnapshot(
	port: number | null,
	read: CorePluginsReader,
): Promise<CorePluginsSnapshot> {
	if (port === null) throw new AgentNotReadyError("getCorePlugins");
	const value = await read(port);
	if (value === null) throw new AgentNotReadyError("getCorePlugins");
	return value;
}
