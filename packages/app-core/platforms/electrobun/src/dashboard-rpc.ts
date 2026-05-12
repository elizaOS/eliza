import { AgentNotReadyError } from "./config-and-auth-rpc";
import {
	finiteNumber,
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
	if (!isRecord(body.wallet)) return null;
	if (!isWalletSource(body.wallet.walletSource)) return null;
	const evmAddress = nullableString(body.wallet.evmAddress);
	const evmAddressShort = nullableString(body.wallet.evmAddressShort);
	const solanaAddress = nullableString(body.wallet.solanaAddress);
	const solanaAddressShort = nullableString(body.wallet.solanaAddressShort);
	const executionBlockedReason = nullableString(
		body.wallet.executionBlockedReason,
	);
	if (
		evmAddress === undefined ||
		evmAddressShort === undefined ||
		solanaAddress === undefined ||
		solanaAddressShort === undefined ||
		typeof body.wallet.hasWallet !== "boolean" ||
		typeof body.wallet.hasEvm !== "boolean" ||
		typeof body.wallet.hasSolana !== "boolean" ||
		typeof body.wallet.localSignerAvailable !== "boolean" ||
		typeof body.wallet.managedBscRpcReady !== "boolean" ||
		typeof body.wallet.rpcReady !== "boolean" ||
		typeof body.wallet.pluginEvmLoaded !== "boolean" ||
		typeof body.wallet.pluginEvmRequired !== "boolean" ||
		typeof body.wallet.executionReady !== "boolean" ||
		executionBlockedReason === undefined
	) {
		return null;
	}

	if (!isRecord(body.plugins)) return null;
	const active = parseStringArray(body.plugins.active);
	const aiProviders = parseStringArray(body.plugins.aiProviders);
	const connectors = parseStringArray(body.plugins.connectors);
	const totalActive = finiteNumber(body.plugins.totalActive);
	if (
		active === null ||
		aiProviders === null ||
		connectors === null ||
		totalActive === null
	) {
		return null;
	}

	if (!isRecord(body.capabilities)) return null;
	const canTrade = body.capabilities.canTrade;
	const canLocalTrade = body.capabilities.canLocalTrade;
	const canAutoTrade = body.capabilities.canAutoTrade;
	const canUseBrowser = body.capabilities.canUseBrowser;
	const canUseComputer = body.capabilities.canUseComputer;
	const canRunTerminal = body.capabilities.canRunTerminal;
	const canInstallPlugins = body.capabilities.canInstallPlugins;
	const canConfigurePlugins = body.capabilities.canConfigurePlugins;
	const canConfigureConnectors = body.capabilities.canConfigureConnectors;
	if (
		typeof canTrade !== "boolean" ||
		typeof canLocalTrade !== "boolean" ||
		typeof canAutoTrade !== "boolean" ||
		typeof canUseBrowser !== "boolean" ||
		typeof canUseComputer !== "boolean" ||
		typeof canRunTerminal !== "boolean" ||
		typeof canInstallPlugins !== "boolean" ||
		typeof canConfigurePlugins !== "boolean" ||
		typeof canConfigureConnectors !== "boolean"
	) {
		return null;
	}

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
		wallet: {
			walletSource: body.wallet.walletSource,
			evmAddress,
			evmAddressShort,
			solanaAddress,
			solanaAddressShort,
			hasWallet: body.wallet.hasWallet,
			hasEvm: body.wallet.hasEvm,
			hasSolana: body.wallet.hasSolana,
			localSignerAvailable: body.wallet.localSignerAvailable,
			managedBscRpcReady: body.wallet.managedBscRpcReady,
			rpcReady: body.wallet.rpcReady,
			pluginEvmLoaded: body.wallet.pluginEvmLoaded,
			pluginEvmRequired: body.wallet.pluginEvmRequired,
			executionReady: body.wallet.executionReady,
			executionBlockedReason,
		},
		plugins: {
			totalActive,
			active,
			aiProviders,
			connectors,
		},
		capabilities: {
			canTrade,
			canLocalTrade,
			canAutoTrade,
			canUseBrowser,
			canUseComputer,
			canRunTerminal,
			canInstallPlugins,
			canConfigurePlugins,
			canConfigureConnectors,
		},
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
