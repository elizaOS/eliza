import { AgentNotReadyError } from "./config-and-auth-rpc";
import type {
	InboxChatsParams,
	InboxChatsSnapshot,
	InboxMessagesParams,
	InboxMessagesSnapshot,
	InboxSourcesSnapshot,
} from "./rpc-schema";

const DEFAULT_TIMEOUT_MS = 4_000;

function appendSources(
	params: URLSearchParams,
	sources?: readonly string[],
): void {
	if (!sources || sources.length === 0) return;
	params.set("sources", sources.join(","));
}

function inboxMessagesPath(options?: InboxMessagesParams): string {
	const params = new URLSearchParams();
	if (typeof options?.limit === "number" && options.limit > 0) {
		params.set("limit", String(options.limit));
	}
	appendSources(params, options?.sources);
	if (typeof options?.roomId === "string" && options.roomId.length > 0) {
		params.set("roomId", options.roomId);
	}
	if (
		typeof options?.roomSource === "string" &&
		options.roomSource.length > 0
	) {
		params.set("roomSource", options.roomSource);
	}
	const query = params.toString();
	return query ? `/api/inbox/messages?${query}` : "/api/inbox/messages";
}

function inboxChatsPath(options?: InboxChatsParams): string {
	const params = new URLSearchParams();
	appendSources(params, options?.sources);
	const query = params.toString();
	return query ? `/api/inbox/chats?${query}` : "/api/inbox/chats";
}

async function fetchJson<T>(port: number, pathname: string): Promise<T | null> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
			method: "GET",
			signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
		});
		if (!response.ok) return null;
		return (await response.json()) as T;
	} catch {
		return null;
	}
}

function objectRecords(value: unknown): Record<string, unknown>[] | null {
	if (!Array.isArray(value)) return null;
	return value.filter(
		(item): item is Record<string, unknown> =>
			typeof item === "object" && item !== null,
	);
}

function stringList(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const strings = value.filter(
		(item): item is string => typeof item === "string",
	);
	return strings.length === value.length ? strings : null;
}

function finiteCount(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export type InboxMessagesReader = (
	port: number,
	params?: InboxMessagesParams,
) => Promise<InboxMessagesSnapshot | null>;

export const readInboxMessagesViaHttp: InboxMessagesReader = async (
	port,
	params,
) => {
	const raw = await fetchJson<Record<string, unknown>>(
		port,
		inboxMessagesPath(params),
	);
	if (!raw) return null;
	const messages = objectRecords(raw.messages);
	const count = finiteCount(raw.count);
	if (!messages || count === null) return null;
	return { messages, count };
};

export async function composeInboxMessagesSnapshot(
	port: number | null,
	params: InboxMessagesParams | undefined,
	read: InboxMessagesReader,
): Promise<InboxMessagesSnapshot> {
	if (port === null) throw new AgentNotReadyError("getInboxMessages");
	const value = await read(port, params);
	if (value === null) throw new AgentNotReadyError("getInboxMessages");
	return value;
}

export type InboxChatsReader = (
	port: number,
	params?: InboxChatsParams,
) => Promise<InboxChatsSnapshot | null>;

export const readInboxChatsViaHttp: InboxChatsReader = async (port, params) => {
	const raw = await fetchJson<Record<string, unknown>>(
		port,
		inboxChatsPath(params),
	);
	if (!raw) return null;
	const chats = objectRecords(raw.chats);
	const count = finiteCount(raw.count);
	if (!chats || count === null) return null;
	return { chats, count };
};

export async function composeInboxChatsSnapshot(
	port: number | null,
	params: InboxChatsParams | undefined,
	read: InboxChatsReader,
): Promise<InboxChatsSnapshot> {
	if (port === null) throw new AgentNotReadyError("getInboxChats");
	const value = await read(port, params);
	if (value === null) throw new AgentNotReadyError("getInboxChats");
	return value;
}

export type InboxSourcesReader = (
	port: number,
) => Promise<InboxSourcesSnapshot | null>;

export const readInboxSourcesViaHttp: InboxSourcesReader = async (port) => {
	const raw = await fetchJson<Record<string, unknown>>(
		port,
		"/api/inbox/sources",
	);
	if (!raw) return null;
	const sources = stringList(raw.sources);
	if (!sources) return null;
	return { sources };
};

export async function composeInboxSourcesSnapshot(
	port: number | null,
	read: InboxSourcesReader,
): Promise<InboxSourcesSnapshot> {
	if (port === null) throw new AgentNotReadyError("getInboxSources");
	const value = await read(port);
	if (value === null) throw new AgentNotReadyError("getInboxSources");
	return value;
}
