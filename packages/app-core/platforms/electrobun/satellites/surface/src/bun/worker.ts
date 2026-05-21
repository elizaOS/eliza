type JsonPrimitive = string | number | boolean | null;
type JsonValue =
	| JsonPrimitive
	| { [key: string]: JsonValue }
	| JsonValue[];

type WorkerRequest = {
	type: "request";
	requestId: string | number;
	method: string;
	params?: JsonValue;
};

type HostResponse = {
	type: "host-response";
	requestId: number;
	success: boolean;
	payload?: JsonValue;
	error?: string;
};

type PendingHostRequest = {
	resolve: (payload: JsonValue | undefined) => void;
	reject: (error: Error) => void;
};

const RUNTIME_SATELLITE_ID = "eliza.runtime";
const pending = new Map<number, PendingHostRequest>();
let nextHostRequestId = 1;

self.onmessage = (event: MessageEvent) => {
	const message = event.data;
	if (isHostResponse(message)) {
		completeHostRequest(message);
		return;
	}
	if (isWorkerRequest(message)) {
		void handleRequest(message);
	}
};

post({ type: "ready" });

async function handleRequest(message: WorkerRequest): Promise<void> {
	try {
		const payload = await invokeRuntime(message.method, message.params);
		post({
			type: "response",
			requestId: message.requestId,
			success: true,
			payload,
		});
	} catch (error) {
		post({
			type: "response",
			requestId: message.requestId,
			success: false,
			error: error instanceof Error ? error.message : "Surface worker failed.",
		});
	}
}

function invokeRuntime(
	method: string,
	params?: JsonValue,
): Promise<JsonValue | undefined> {
	const requestId = nextHostRequestId++;
	post({
		type: "host-request",
		requestId,
		method: "invoke-remote-plugin",
		params: {
			remotePluginId: RUNTIME_SATELLITE_ID,
			method,
			params,
		},
	});

	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pending.delete(requestId);
			reject(new Error(`Runtime Satellite request timed out: ${method}`));
		}, 30_000);
		pending.set(requestId, {
			resolve: (payload) => {
				clearTimeout(timeout);
				resolve(payload);
			},
			reject: (error) => {
				clearTimeout(timeout);
				reject(error);
			},
		});
	});
}

function completeHostRequest(message: HostResponse): void {
	const request = pending.get(message.requestId);
	if (!request) return;
	pending.delete(message.requestId);
	if (message.success) {
		request.resolve(message.payload);
		return;
	}
	request.reject(new Error(message.error ?? "Runtime Satellite request failed."));
}

function isWorkerRequest(value: unknown): value is WorkerRequest {
	if (!isRecord(value)) return false;
	return (
		value.type === "request" &&
		(typeof value.requestId === "string" ||
			typeof value.requestId === "number") &&
		typeof value.method === "string"
	);
}

function isHostResponse(value: unknown): value is HostResponse {
	if (!isRecord(value)) return false;
	return (
		value.type === "host-response" &&
		typeof value.requestId === "number" &&
		typeof value.success === "boolean"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function post(message: unknown): void {
	self.postMessage(message);
}
