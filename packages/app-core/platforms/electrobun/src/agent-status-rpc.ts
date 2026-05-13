import { AgentNotReadyError } from "./config-and-auth-rpc";
import { isRecord } from "./rpc-parse-utils";
import type {
	AgentCloudStatusSnapshot,
	AgentStatusSnapshot,
	AgentStatusState,
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

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function parseStringList(value: unknown): readonly string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) return undefined;
	if (!value.every((entry) => typeof entry === "string")) return undefined;
	return value;
}

function parseCloudStatus(
	value: unknown,
): AgentCloudStatusSnapshot | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) return undefined;
	if (
		typeof value.connectionStatus !== "string" ||
		(value.activeAgentId !== null && typeof value.activeAgentId !== "string") ||
		typeof value.cloudProvisioned !== "boolean" ||
		typeof value.hasApiKey !== "boolean"
	) {
		return undefined;
	}
	return {
		connectionStatus: value.connectionStatus,
		activeAgentId: value.activeAgentId,
		cloudProvisioned: value.cloudProvisioned,
		hasApiKey: value.hasApiKey,
	};
}

function parseStartup(value: unknown): Record<string, unknown> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) return undefined;
	return value;
}

function parseAgentStatusSnapshot(body: unknown): AgentStatusSnapshot | null {
	if (!isRecord(body)) return null;
	if (!isAgentStatusState(body.state)) return null;
	if (typeof body.agentName !== "string") return null;

	const pendingRestartReasons = parseStringList(body.pendingRestartReasons);
	if (
		body.pendingRestartReasons !== undefined &&
		pendingRestartReasons === undefined
	) {
		return null;
	}

	const cloud = parseCloudStatus(body.cloud);
	if (body.cloud !== undefined && cloud === undefined) return null;

	const startup = parseStartup(body.startup);
	if (body.startup !== undefined && startup === undefined) return null;

	const model = optionalString(body.model);
	const uptime = optionalNumber(body.uptime);
	const startedAt = optionalNumber(body.startedAt);
	const port = optionalNumber(body.port);

	return {
		state: body.state,
		agentName: body.agentName,
		...(model === undefined ? {} : { model }),
		...(uptime === undefined ? {} : { uptime }),
		...(startedAt === undefined ? {} : { startedAt }),
		...(port === undefined ? {} : { port }),
		...(typeof body.pendingRestart === "boolean"
			? { pendingRestart: body.pendingRestart }
			: {}),
		...(pendingRestartReasons === undefined ? {} : { pendingRestartReasons }),
		...(startup === undefined ? {} : { startup }),
		...(cloud === undefined ? {} : { cloud }),
	};
}

export type AgentStatusReader = (
	port: number,
) => Promise<AgentStatusSnapshot | null>;

export const readAgentStatusViaHttp: AgentStatusReader = async (port) => {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/api/status`, {
			method: "GET",
			signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
		});
		if (!response.ok) return null;
		return parseAgentStatusSnapshot(await response.json());
	} catch {
		return null;
	}
};

export async function composeAgentStatusSnapshot(
	port: number | null,
	read: AgentStatusReader,
): Promise<AgentStatusSnapshot> {
	if (port === null) throw new AgentNotReadyError("getAgentStatus");
	const value = await read(port);
	if (value === null) throw new AgentNotReadyError("getAgentStatus");
	return value;
}
