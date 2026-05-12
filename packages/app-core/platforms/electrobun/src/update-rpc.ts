import { AgentNotReadyError } from "./config-and-auth-rpc";
import type {
	AgentUpdateReleaseChannel,
	AgentUpdateStatusSnapshot,
} from "./rpc-schema";

const DEFAULT_TIMEOUT_MS = 4_000;
const RELEASE_CHANNELS: readonly AgentUpdateReleaseChannel[] = [
	"stable",
	"beta",
	"nightly",
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReleaseChannel(value: unknown): value is AgentUpdateReleaseChannel {
	return (
		typeof value === "string" &&
		RELEASE_CHANNELS.some((channel) => channel === value)
	);
}

function nullableString(value: unknown): string | null | undefined {
	if (value === null) return null;
	return typeof value === "string" ? value : undefined;
}

function parseNullableReleaseChannelRecord(
	value: unknown,
): Record<AgentUpdateReleaseChannel, string | null> | null {
	if (!isRecord(value)) return null;
	const output: Partial<Record<AgentUpdateReleaseChannel, string | null>> = {};
	for (const channel of RELEASE_CHANNELS) {
		const entry = value[channel];
		if (typeof entry === "string") {
			output[channel] = entry;
			continue;
		}
		if (entry === null) {
			output[channel] = null;
			continue;
		}
		return null;
	}
	return output as Record<AgentUpdateReleaseChannel, string | null>;
}

function parseStringReleaseChannelRecord(
	value: unknown,
): Record<AgentUpdateReleaseChannel, string> | null {
	if (!isRecord(value)) return null;
	const output: Partial<Record<AgentUpdateReleaseChannel, string>> = {};
	for (const channel of RELEASE_CHANNELS) {
		const entry = value[channel];
		if (typeof entry !== "string") return null;
		output[channel] = entry;
	}
	return output as Record<AgentUpdateReleaseChannel, string>;
}

function parseUpdateStatusSnapshot(
	body: unknown,
): AgentUpdateStatusSnapshot | null {
	if (!isRecord(body)) return null;
	if (typeof body.currentVersion !== "string") return null;
	if (!isReleaseChannel(body.channel)) return null;
	if (typeof body.installMethod !== "string") return null;
	if (typeof body.updateAvailable !== "boolean") return null;

	const latestVersion = nullableString(body.latestVersion);
	if (latestVersion === undefined) return null;
	const lastCheckAt = nullableString(body.lastCheckAt);
	if (lastCheckAt === undefined) return null;
	const error = nullableString(body.error);
	if (error === undefined) return null;

	const channels = parseNullableReleaseChannelRecord(body.channels);
	if (channels === null) return null;
	const distTags = parseStringReleaseChannelRecord(body.distTags);
	if (distTags === null) return null;

	return {
		currentVersion: body.currentVersion,
		channel: body.channel,
		installMethod: body.installMethod,
		updateAvailable: body.updateAvailable,
		latestVersion,
		channels,
		distTags,
		lastCheckAt,
		error,
	};
}

export type UpdateStatusReader = (
	port: number,
	force: boolean,
) => Promise<AgentUpdateStatusSnapshot | null>;

export const readUpdateStatusViaHttp: UpdateStatusReader = async (
	port,
	force,
) => {
	const suffix = force ? "?force=true" : "";
	try {
		const response = await fetch(
			`http://127.0.0.1:${port}/api/update/status${suffix}`,
			{
				method: "GET",
				signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
			},
		);
		if (!response.ok) return null;
		return parseUpdateStatusSnapshot(await response.json());
	} catch {
		return null;
	}
};

export async function composeUpdateStatusSnapshot(
	port: number | null,
	force: boolean,
	read: UpdateStatusReader,
): Promise<AgentUpdateStatusSnapshot> {
	if (port === null) throw new AgentNotReadyError("getUpdateStatus");
	const value = await read(port, force);
	if (value === null) throw new AgentNotReadyError("getUpdateStatus");
	return value;
}
