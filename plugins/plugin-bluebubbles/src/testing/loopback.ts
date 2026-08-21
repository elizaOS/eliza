/**
 * Runs a deterministic BlueBubbles v1 loopback for connector and scenario
 * tests. The harness owns only the external BlueBubbles server boundary; it
 * does not emulate or claim coverage for the native local iMessage connector.
 */

import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";

export interface BlueBubblesLoopbackChat {
	guid: string;
	chatIdentifier: string;
	displayName: string | null;
	participants: Array<{ address: string; service: string }>;
}

export interface BlueBubblesLoopbackMessage {
	guid: string;
	text: string | null;
	dateCreated: number;
	chatGuid: string;
	tempGuid?: string;
	isFromMe: boolean;
	dateRead?: number | null;
	dateEdited?: number | null;
}

export interface BlueBubblesLoopbackAccount {
	accountId: string;
	password: string;
	chats: readonly BlueBubblesLoopbackChat[];
	messages?: readonly BlueBubblesLoopbackMessage[];
}

export type BlueBubblesLoopbackFault =
	| {
			type: "status";
			status: number;
			body?: unknown;
			headers?: Record<string, string>;
	  }
	| { type: "delay"; durationMs: number }
	| { type: "malformed-json"; body?: string }
	| { type: "schema-drift"; body: unknown };

export interface BlueBubblesMockReceipt {
	sequence: number;
	evidence: "mock-only";
	kind: "request" | "effect" | "webhook";
	operation: string;
	accountId: string | null;
	outcome: "succeeded" | "rejected" | "ambiguous" | "replayed";
	idempotencyKey: string | null;
	occurredAt: string;
	detail: Record<string, unknown>;
}

export interface BlueBubblesLoopbackSnapshot {
	accounts: Array<{
		accountId: string;
		chats: string[];
		messages: BlueBubblesLoopbackMessage[];
	}>;
	pendingFaults: Array<{ target: string; count: number }>;
	receipts: BlueBubblesMockReceipt[];
}

export interface RunningBlueBubblesLoopback {
	readonly owner: "bluebubbles-external";
	url: string;
	readonly receipts: readonly BlueBubblesMockReceipt[];
	fault(method: string, path: string, fault: BlueBubblesLoopbackFault): void;
	reset(): BlueBubblesLoopbackSnapshot;
	snapshot(): BlueBubblesLoopbackSnapshot;
	deliverWebhook(
		targetUrl: string,
		event: {
			id: string;
			sequence: number;
			accountId: string;
			type: "new-message" | "updated-message" | "chat-updated";
			data: Record<string, unknown>;
		},
		secret: string,
		options?: { maxAttempts?: number; retryDelayMs?: number },
	): Promise<Response[]>;
	stop(): Promise<void>;
}

export interface StartBlueBubblesLoopbackOptions {
	accounts: readonly BlueBubblesLoopbackAccount[];
	now?: () => number;
	sleep?: (durationMs: number) => Promise<void>;
}

interface AccountState {
	accountId: string;
	password: string;
	chats: Map<string, BlueBubblesLoopbackChat>;
	messages: Map<string, BlueBubblesLoopbackMessage>;
	tempGuids: Map<string, string>;
}

/** Starts a stateful protocol server on an ephemeral loopback port. */
export async function startBlueBubblesLoopback(
	options: StartBlueBubblesLoopbackOptions,
): Promise<RunningBlueBubblesLoopback> {
	if (options.accounts.length === 0) {
		throw new Error("BlueBubbles loopback requires at least one account");
	}
	const initialAccounts = structuredClone(options.accounts);
	const accounts = new Map<string, AccountState>();
	const passwordOwners = new Map<string, string>();
	const faults = new Map<string, BlueBubblesLoopbackFault[]>();
	const receipts: BlueBubblesMockReceipt[] = [];
	const deliveredWebhookIds = new Set<string>();
	const latestWebhookSequences = new Map<string, number>();
	const now = options.now ?? Date.now;
	const sleep =
		options.sleep ??
		((durationMs: number) =>
			new Promise<void>((resolve) => setTimeout(resolve, durationMs)));
	let receiptSequence = 0;

	const restore = (): void => {
		accounts.clear();
		passwordOwners.clear();
		for (const seed of initialAccounts) {
			if (accounts.has(seed.accountId) || passwordOwners.has(seed.password)) {
				throw new Error(
					"BlueBubbles loopback account IDs and passwords must be unique",
				);
			}
			const messages = new Map(
				(seed.messages ?? []).map((message) => [
					message.guid,
					structuredClone(message),
				]),
			);
			accounts.set(seed.accountId, {
				accountId: seed.accountId,
				password: seed.password,
				chats: new Map(
					seed.chats.map((chat) => [chat.guid, structuredClone(chat)]),
				),
				messages,
				tempGuids: new Map(
					[...messages.values()]
						.filter((message) => message.tempGuid)
						.map((message) => [message.tempGuid as string, message.guid]),
				),
			});
			passwordOwners.set(seed.password, seed.accountId);
		}
		faults.clear();
		receipts.length = 0;
		deliveredWebhookIds.clear();
		latestWebhookSequences.clear();
		receiptSequence = 0;
	};
	restore();

	const append = (
		receipt: Omit<
			BlueBubblesMockReceipt,
			"sequence" | "evidence" | "occurredAt"
		>,
	): void => {
		receipts.push({
			...structuredClone(receipt),
			sequence: ++receiptSequence,
			evidence: "mock-only",
			occurredAt: new Date(now()).toISOString(),
		});
	};

	const server = createServer(async (request, response) => {
		try {
			await handleProtocolRequest(
				request,
				response,
				accounts,
				passwordOwners,
				faults,
				append,
				now,
				sleep,
			);
		} catch (error) {
			json(response, 500, protocolEnvelope(500, null, String(error)));
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("BlueBubbles loopback did not bind an IP port");
	}

	const snapshot = (): BlueBubblesLoopbackSnapshot => ({
		accounts: [...accounts.values()]
			.map((account) => ({
				accountId: account.accountId,
				chats: [...account.chats.keys()].sort(),
				messages: [...account.messages.values()].map((message) =>
					structuredClone(message),
				),
			}))
			.sort((left, right) => left.accountId.localeCompare(right.accountId)),
		pendingFaults: [...faults.entries()]
			.map(([target, queue]) => ({ target, count: queue.length }))
			.sort((left, right) => left.target.localeCompare(right.target)),
		receipts: structuredClone(receipts),
	});

	return {
		owner: "bluebubbles-external",
		url: `http://127.0.0.1:${address.port}`,
		get receipts() {
			return structuredClone(receipts);
		},
		fault(method, path, fault) {
			const key = `${method.toUpperCase()} ${path}`;
			faults.set(key, [...(faults.get(key) ?? []), structuredClone(fault)]);
		},
		reset() {
			restore();
			return snapshot();
		},
		snapshot,
		async deliverWebhook(targetUrl, event, secret, deliveryOptions = {}) {
			const responses: Response[] = [];
			const maxAttempts = deliveryOptions.maxAttempts ?? 3;
			const retryDelayMs = deliveryOptions.retryDelayMs ?? 0;
			for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
				const deliveryKey = `${event.accountId}:${event.id}`;
				const duplicate = deliveredWebhookIds.has(deliveryKey);
				const latestSequence = latestWebhookSequences.get(event.accountId) ?? 0;
				const response = await fetch(targetUrl, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-bluebubbles-webhook-secret": secret,
					},
					body: JSON.stringify({ type: event.type, data: event.data }),
				});
				responses.push(response);
				append({
					kind: "webhook",
					operation: event.type,
					accountId: event.accountId,
					outcome: duplicate
						? "replayed"
						: response.ok
							? "succeeded"
							: "rejected",
					idempotencyKey: event.id,
					detail: {
						attempt,
						status: response.status,
						sequence: event.sequence,
						outOfOrder: event.sequence <= latestSequence,
					},
				});
				if (response.ok) {
					deliveredWebhookIds.add(deliveryKey);
					latestWebhookSequences.set(
						event.accountId,
						Math.max(latestSequence, event.sequence),
					);
					break;
				}
				if (attempt < maxAttempts) await sleep(retryDelayMs);
			}
			return responses;
		},
		async stop() {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		},
	};
}

type AppendReceipt = (
	receipt: Omit<BlueBubblesMockReceipt, "sequence" | "evidence" | "occurredAt">,
) => void;

async function handleProtocolRequest(
	request: IncomingMessage,
	response: ServerResponse,
	accounts: Map<string, AccountState>,
	passwordOwners: Map<string, string>,
	faults: Map<string, BlueBubblesLoopbackFault[]>,
	append: AppendReceipt,
	now: () => number,
	sleep: (durationMs: number) => Promise<void>,
): Promise<void> {
	const url = new URL(request.url ?? "/", "http://127.0.0.1");
	const method = request.method ?? "GET";
	const key = `${method} ${url.pathname}`;
	const body = await readBody(request);
	const password = url.searchParams.get("password") ?? "";
	const accountId = passwordOwners.get(password);
	const account = accountId ? accounts.get(accountId) : undefined;
	append({
		kind: "request",
		operation: key,
		accountId: accountId ?? null,
		outcome: account ? "succeeded" : "rejected",
		idempotencyKey: null,
		detail: {
			path: url.pathname,
			query: Object.fromEntries(
				[...url.searchParams.entries()].map(([name, value]) => [
					name,
					name.toLowerCase().includes("password") ? "<redacted>" : value,
				]),
			),
			body: redactSecrets(body, passwordOwners.keys()),
		},
	});
	if (!account) {
		json(response, 401, protocolEnvelope(401, null, "Unauthorized"));
		return;
	}
	const queue = faults.get(key) ?? [];
	const fault = queue.shift();
	if (queue.length === 0) faults.delete(key);
	else faults.set(key, queue);
	if (fault?.type === "delay") await sleep(fault.durationMs);

	if (method === "POST" && url.pathname === "/api/v1/message/text") {
		const parsed = parseObject(body);
		const chatGuid = parsed ? stringField(parsed, "chatGuid") : null;
		const text = parsed ? stringField(parsed, "message") : null;
		const tempGuid = parsed ? stringField(parsed, "tempGuid") : null;
		if (!chatGuid || !text || !account.chats.has(chatGuid)) {
			json(response, 422, protocolEnvelope(422, null, "Invalid message"));
			return;
		}
		const existingGuid = tempGuid ? account.tempGuids.get(tempGuid) : undefined;
		if (existingGuid) {
			const existing = account.messages.get(existingGuid);
			append({
				kind: "effect",
				operation: "message.send",
				accountId: account.accountId,
				outcome: "replayed",
				idempotencyKey: tempGuid,
				detail: { messageGuid: existingGuid },
			});
			json(
				response,
				200,
				protocolEnvelope(200, toProtocolMessage(existing, account)),
			);
			return;
		}
		const guid = `msg-${account.accountId}-${account.messages.size + 1}`;
		const message: BlueBubblesLoopbackMessage = {
			guid,
			text,
			dateCreated: now(),
			chatGuid,
			tempGuid: tempGuid ?? undefined,
			isFromMe: true,
		};
		const ambiguous = fault?.type === "status" && fault.status >= 500;
		if (!fault || fault.type === "delay" || ambiguous) {
			account.messages.set(guid, message);
			if (tempGuid) account.tempGuids.set(tempGuid, guid);
			append({
				kind: "effect",
				operation: "message.send",
				accountId: account.accountId,
				outcome: ambiguous ? "ambiguous" : "succeeded",
				idempotencyKey: tempGuid,
				detail: { messageGuid: guid },
			});
		}
		if (writeFault(response, fault)) return;
		json(
			response,
			200,
			protocolEnvelope(200, toProtocolMessage(message, account)),
		);
		return;
	}
	if (method === "POST" && url.pathname === "/api/v1/message/attachment") {
		const chatGuid = multipartField(body, "chatGuid");
		const tempGuid = multipartField(body, "tempGuid");
		if (!chatGuid || !account.chats.has(chatGuid)) {
			json(response, 422, protocolEnvelope(422, null, "Invalid attachment"));
			return;
		}
		const existingGuid = tempGuid ? account.tempGuids.get(tempGuid) : undefined;
		if (existingGuid) {
			append({
				kind: "effect",
				operation: "attachment.send",
				accountId: account.accountId,
				outcome: "replayed",
				idempotencyKey: tempGuid,
				detail: { messageGuid: existingGuid },
			});
			json(
				response,
				200,
				protocolEnvelope(
					200,
					toProtocolMessage(account.messages.get(existingGuid), account),
				),
			);
			return;
		}
		const guid = `attachment-${account.accountId}-${account.messages.size + 1}`;
		const message: BlueBubblesLoopbackMessage = {
			guid,
			text: multipartField(body, "message"),
			dateCreated: now(),
			chatGuid,
			tempGuid: tempGuid ?? undefined,
			isFromMe: true,
		};
		const ambiguous = fault?.type === "status" && fault.status >= 500;
		if (!fault || fault.type === "delay" || ambiguous) {
			account.messages.set(guid, message);
			if (tempGuid) account.tempGuids.set(tempGuid, guid);
			append({
				kind: "effect",
				operation: "attachment.send",
				accountId: account.accountId,
				outcome: ambiguous ? "ambiguous" : "succeeded",
				idempotencyKey: tempGuid,
				detail: { messageGuid: guid },
			});
		}
		if (writeFault(response, fault)) return;
		json(
			response,
			200,
			protocolEnvelope(200, toProtocolMessage(message, account)),
		);
		return;
	}

	if (writeFault(response, fault)) return;
	if (method === "GET" && url.pathname === "/api/v1/server/info") {
		json(
			response,
			200,
			protocolEnvelope(200, {
				os_version: "14.6-loopback",
				server_version: "1.9.9",
				private_api: true,
				helper_connected: true,
				proxy_service: null,
				detected_icloud: null,
			}),
		);
		return;
	}
	if (method === "POST" && url.pathname === "/api/v1/chat/query") {
		const parsed = parseObject(body) ?? {};
		const limit = numberField(parsed, "limit") ?? 100;
		const offset = numberField(parsed, "offset") ?? 0;
		json(
			response,
			200,
			protocolEnvelope(
				200,
				[...account.chats.values()].slice(offset, offset + limit),
			),
		);
		return;
	}
	const chatMatch = url.pathname.match(/^\/api\/v1\/chat\/([^/]+)$/);
	if (method === "GET" && chatMatch?.[1]) {
		const matchingChat = account.chats.get(decodeURIComponent(chatMatch[1]));
		json(
			response,
			matchingChat ? 200 : 404,
			protocolEnvelope(
				matchingChat ? 200 : 404,
				matchingChat ?? null,
				matchingChat ? "OK" : "Chat does not exist",
			),
		);
		return;
	}
	const messageMatch = url.pathname.match(
		/^\/api\/v1\/chat\/([^/]+)\/message$/,
	);
	if (method === "GET" && messageMatch?.[1]) {
		const chatGuid = decodeURIComponent(messageMatch[1]);
		const limit = Number(url.searchParams.get("limit") ?? 50);
		const offset = Number(url.searchParams.get("offset") ?? 0);
		json(
			response,
			200,
			protocolEnvelope(
				200,
				[...account.messages.values()]
					.filter((message) => message.chatGuid === chatGuid)
					.slice(offset, offset + limit)
					.map((message) => toProtocolMessage(message, account)),
			),
		);
		return;
	}
	const readMatch = url.pathname.match(/^\/api\/v1\/chat\/([^/]+)\/read$/);
	if (method === "POST" && readMatch?.[1]) {
		const chatGuid = decodeURIComponent(readMatch[1]);
		for (const message of account.messages.values()) {
			if (message.chatGuid === chatGuid && !message.isFromMe)
				message.dateRead = now();
		}
		append({
			kind: "effect",
			operation: "chat.mark-read",
			accountId: account.accountId,
			outcome: "succeeded",
			idempotencyKey: chatGuid,
			detail: { chatGuid },
		});
		json(response, 200, protocolEnvelope(200, { success: true }));
		return;
	}
	if (method === "POST" && url.pathname === "/api/v1/message/react") {
		const parsed = parseObject(body);
		const messageGuid = parsed ? stringField(parsed, "messageGuid") : null;
		const reaction = parsed ? stringField(parsed, "reaction") : null;
		if (!messageGuid || !reaction || !account.messages.has(messageGuid)) {
			json(response, 422, protocolEnvelope(422, null, "Invalid reaction"));
			return;
		}
		append({
			kind: "effect",
			operation: "message.react",
			accountId: account.accountId,
			outcome: "succeeded",
			idempotencyKey: `${messageGuid}:${reaction}`,
			detail: { messageGuid, reaction },
		});
		json(response, 200, protocolEnvelope(200, { success: true }));
		return;
	}
	const mutationMatch = url.pathname.match(
		/^\/api\/v1\/message\/([^/]+)\/(edit|unsend)$/,
	);
	if (method === "POST" && mutationMatch?.[1] && mutationMatch[2]) {
		const messageGuid = decodeURIComponent(mutationMatch[1]);
		const message = account.messages.get(messageGuid);
		if (!message) {
			json(
				response,
				404,
				protocolEnvelope(404, null, "Message does not exist"),
			);
			return;
		}
		if (mutationMatch[2] === "edit") {
			const parsed = parseObject(body);
			const editedMessage = parsed
				? stringField(parsed, "editedMessage")
				: null;
			if (!editedMessage) {
				json(response, 422, protocolEnvelope(422, null, "Invalid edit"));
				return;
			}
			message.text = editedMessage;
			message.dateEdited = now();
		} else {
			account.messages.delete(messageGuid);
			if (message.tempGuid) account.tempGuids.delete(message.tempGuid);
		}
		append({
			kind: "effect",
			operation: `message.${mutationMatch[2]}`,
			accountId: account.accountId,
			outcome: "succeeded",
			idempotencyKey: messageGuid,
			detail: { messageGuid },
		});
		json(response, 200, protocolEnvelope(200, { success: true }));
		return;
	}
	json(response, 404, protocolEnvelope(404, null, "Not Found"));
}

function writeFault(
	response: ServerResponse,
	fault: BlueBubblesLoopbackFault | undefined,
): boolean {
	if (!fault || fault.type === "delay") return false;
	if (fault.type === "malformed-json") {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(fault.body ?? "{not-json");
		return true;
	}
	if (fault.type === "schema-drift") {
		json(response, 200, fault.body);
		return true;
	}
	json(
		response,
		fault.status,
		fault.body ?? protocolEnvelope(fault.status, null, "Injected fault"),
		fault.headers,
	);
	return true;
}

function protocolEnvelope(status: number, data: unknown, message = "OK") {
	return status >= 400
		? { status, message, error: { type: "Loopback Error", message }, data }
		: { status, message, data };
}

function toProtocolMessage(
	message: BlueBubblesLoopbackMessage | undefined,
	account: AccountState,
): Record<string, unknown> | null {
	if (!message) return null;
	const chat = account.chats.get(message.chatGuid);
	const participant = chat?.participants[0];
	return {
		guid: message.guid,
		text: message.text,
		subject: null,
		country: null,
		handle: participant
			? {
					...participant,
					country: null,
					originalROWID: 1,
					uncanonicalizedId: null,
				}
			: null,
		handleId: 1,
		otherHandle: 0,
		chats: chat ? [{ ...chat, lastMessage: null }] : [],
		attachments: [],
		expressiveSendStyleId: null,
		dateCreated: message.dateCreated,
		dateRead: message.dateRead ?? null,
		dateDelivered: null,
		isFromMe: message.isFromMe,
		isDelayed: false,
		isAutoReply: false,
		isSystemMessage: false,
		isServiceMessage: false,
		isForward: false,
		isArchived: false,
		hasDdResults: false,
		hasPayloadData: false,
		threadOriginatorGuid: null,
		threadOriginatorPart: null,
		associatedMessageGuid: null,
		associatedMessageType: null,
		balloonBundleId: null,
		dateEdited: message.dateEdited ?? null,
		error: 0,
		itemType: 0,
		groupTitle: null,
		groupActionType: 0,
		payloadData: null,
	};
}

function parseObject(body: string): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(body);
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function stringField(
	value: Record<string, unknown>,
	field: string,
): string | null {
	const candidate = value[field];
	return typeof candidate === "string" && candidate.length > 0
		? candidate
		: null;
}

function numberField(
	value: Record<string, unknown>,
	field: string,
): number | null {
	const candidate = value[field];
	return typeof candidate === "number" && Number.isFinite(candidate)
		? candidate
		: null;
}

function multipartField(body: string, field: string): string | null {
	const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = body.match(
		new RegExp(
			`name="${escaped}"(?:;[^\\r\\n]*)?\\r?\\n(?:[^\\r\\n]*\\r?\\n)?\\r?\\n([^\\r\\n]+)`,
		),
	);
	return match?.[1]?.trim() || null;
}

function redactSecrets(value: string, secrets: Iterable<string>): string {
	let redacted = value;
	for (const secret of secrets) {
		for (const candidate of [
			secret,
			encodeURIComponent(secret),
			encodeURIComponent(encodeURIComponent(secret)),
		]
			.filter(Boolean)
			.sort((left, right) => right.length - left.length)) {
			redacted = redacted.split(candidate).join("<redacted>");
		}
	}
	return redacted;
}

async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf8");
}

function json(
	response: ServerResponse,
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
): void {
	response.writeHead(status, {
		"content-type": "application/json",
		...headers,
	});
	response.end(JSON.stringify(body));
}
