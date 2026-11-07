import { AgentNotReadyError } from "./config-and-auth-rpc";
import {
	finiteNumber,
	isRecord,
	nullableString,
	optionalString,
} from "./rpc-parse-utils";
import type {
	AgentStatusState,
	RuntimeDebugSnapshot,
	RuntimeDebugSnapshotParams,
	RuntimeOrderItem,
	RuntimeServiceOrderItem,
} from "./rpc-schema";

const DEFAULT_TIMEOUT_MS = 4_000;
const AGENT_STATUS_STATES: readonly AgentStatusState[] = [
	"not_started",
	"starting",
	"running",
	"stopped",
	"restarting",
	"error",
];

function isAgentStatusState(value: unknown): value is AgentStatusState {
	return (
		typeof value === "string" &&
		AGENT_STATUS_STATES.some((state) => state === value)
	);
}

function parseOrderItem(value: unknown): RuntimeOrderItem | null {
	if (!isRecord(value)) return null;
	const index = finiteNumber(value.index);
	const id = nullableString(value.id);
	if (index === null || id === undefined) return null;
	if (typeof value.name !== "string") return null;
	if (typeof value.className !== "string") return null;
	return {
		index,
		name: value.name,
		className: value.className,
		id,
	};
}

function parseOrderItems(value: unknown): RuntimeOrderItem[] | null {
	if (!Array.isArray(value)) return null;
	const output: RuntimeOrderItem[] = [];
	for (const entry of value) {
		const parsed = parseOrderItem(entry);
		if (parsed === null) return null;
		output.push(parsed);
	}
	return output;
}

function parseServiceOrderItem(value: unknown): RuntimeServiceOrderItem | null {
	if (!isRecord(value)) return null;
	const index = finiteNumber(value.index);
	const count = finiteNumber(value.count);
	const instances = parseOrderItems(value.instances);
	if (index === null || count === null || instances === null) return null;
	if (typeof value.serviceType !== "string") return null;
	return {
		index,
		serviceType: value.serviceType,
		count,
		instances,
	};
}

function parseServiceOrderItems(
	value: unknown,
): RuntimeServiceOrderItem[] | null {
	if (!Array.isArray(value)) return null;
	const output: RuntimeServiceOrderItem[] = [];
	for (const entry of value) {
		const parsed = parseServiceOrderItem(entry);
		if (parsed === null) return null;
		output.push(parsed);
	}
	return output;
}

function parseRuntimeDebugSnapshot(body: unknown): RuntimeDebugSnapshot | null {
	if (!isRecord(body)) return null;
	if (typeof body.runtimeAvailable !== "boolean") return null;
	const generatedAt = finiteNumber(body.generatedAt);
	if (generatedAt === null) return null;
	if (!isRecord(body.settings)) return null;
	const maxDepth = finiteNumber(body.settings.maxDepth);
	const maxArrayLength = finiteNumber(body.settings.maxArrayLength);
	const maxObjectEntries = finiteNumber(body.settings.maxObjectEntries);
	const maxStringLength = finiteNumber(body.settings.maxStringLength);
	if (
		maxDepth === null ||
		maxArrayLength === null ||
		maxObjectEntries === null ||
		maxStringLength === null
	) {
		return null;
	}

	if (!isRecord(body.meta)) return null;
	const agentId = optionalString(body.meta.agentId);
	const model = nullableString(body.meta.model);
	const pluginCount = finiteNumber(body.meta.pluginCount);
	const actionCount = finiteNumber(body.meta.actionCount);
	const providerCount = finiteNumber(body.meta.providerCount);
	const evaluatorCount = finiteNumber(body.meta.evaluatorCount);
	const serviceTypeCount = finiteNumber(body.meta.serviceTypeCount);
	const serviceCount = finiteNumber(body.meta.serviceCount);
	if (
		agentId === false ||
		model === undefined ||
		!isAgentStatusState(body.meta.agentState) ||
		typeof body.meta.agentName !== "string" ||
		pluginCount === null ||
		actionCount === null ||
		providerCount === null ||
		evaluatorCount === null ||
		serviceTypeCount === null ||
		serviceCount === null
	) {
		return null;
	}

	if (!isRecord(body.order)) return null;
	const plugins = parseOrderItems(body.order.plugins);
	const actions = parseOrderItems(body.order.actions);
	const providers = parseOrderItems(body.order.providers);
	const evaluators = parseOrderItems(body.order.evaluators);
	const services = parseServiceOrderItems(body.order.services);
	if (
		plugins === null ||
		actions === null ||
		providers === null ||
		evaluators === null ||
		services === null
	) {
		return null;
	}

	if (!isRecord(body.sections)) return null;

	return {
		runtimeAvailable: body.runtimeAvailable,
		generatedAt,
		settings: {
			maxDepth,
			maxArrayLength,
			maxObjectEntries,
			maxStringLength,
		},
		meta: {
			...(agentId === undefined ? {} : { agentId }),
			agentState: body.meta.agentState,
			agentName: body.meta.agentName,
			model,
			pluginCount,
			actionCount,
			providerCount,
			evaluatorCount,
			serviceTypeCount,
			serviceCount,
		},
		order: {
			plugins,
			actions,
			providers,
			evaluators,
			services,
		},
		sections: {
			runtime: body.sections.runtime,
			plugins: body.sections.plugins,
			actions: body.sections.actions,
			providers: body.sections.providers,
			evaluators: body.sections.evaluators,
			services: body.sections.services,
		},
	};
}

function runtimeSnapshotQuery(params?: RuntimeDebugSnapshotParams): string {
	const query = new URLSearchParams();
	if (typeof params?.depth === "number")
		query.set("depth", String(params.depth));
	if (typeof params?.maxArrayLength === "number") {
		query.set("maxArrayLength", String(params.maxArrayLength));
	}
	if (typeof params?.maxObjectEntries === "number") {
		query.set("maxObjectEntries", String(params.maxObjectEntries));
	}
	if (typeof params?.maxStringLength === "number") {
		query.set("maxStringLength", String(params.maxStringLength));
	}
	const text = query.toString();
	return text.length > 0 ? `?${text}` : "";
}

export type RuntimeSnapshotReader = (
	port: number,
	params?: RuntimeDebugSnapshotParams,
) => Promise<RuntimeDebugSnapshot | null>;

export const readRuntimeSnapshotViaHttp: RuntimeSnapshotReader = async (
	port,
	params,
) => {
	try {
		const response = await fetch(
			`http://127.0.0.1:${port}/api/runtime${runtimeSnapshotQuery(params)}`,
			{
				method: "GET",
				signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
			},
		);
		if (!response.ok) return null;
		return parseRuntimeDebugSnapshot(await response.json());
	} catch {
		return null;
	}
};

export async function composeRuntimeSnapshot(
	port: number | null,
	params: RuntimeDebugSnapshotParams | undefined,
	read: RuntimeSnapshotReader,
): Promise<RuntimeDebugSnapshot> {
	if (port === null) throw new AgentNotReadyError("getRuntimeSnapshot");
	const value = await read(port, params);
	if (value === null) throw new AgentNotReadyError("getRuntimeSnapshot");
	return value;
}
