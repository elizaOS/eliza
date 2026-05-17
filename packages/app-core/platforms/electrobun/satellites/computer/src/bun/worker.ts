import { ComputerSatelliteService } from "./computer-service.ts";
import { serializeComputerError } from "./errors.ts";
import type {
	ComputerMethod,
	ComputerResponsePayload,
	ComputerScreenshotParams,
	ComputerWorkerOutboundMessage,
	ComputerWorkerRequestMessage,
	JsonValue,
} from "./protocol.ts";

const service = new ComputerSatelliteService();

function post(message: ComputerWorkerOutboundMessage): void {
	self.postMessage(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isComputerMethod(value: string): value is ComputerMethod {
	return (
		value === "computer.status" ||
		value === "computer.permissions" ||
		value === "computer.displays" ||
		value === "computer.screenshot"
	);
}

function parseRequest(value: unknown): ComputerWorkerRequestMessage | null {
	if (!isRecord(value)) return null;
	if (value.type !== "request") return null;
	const requestId = value.requestId;
	const method = value.method;
	if (
		(typeof requestId !== "string" && typeof requestId !== "number") ||
		typeof method !== "string" ||
		!isComputerMethod(method)
	) {
		throw new Error("Invalid Computer Satellite request.");
	}
	const params = value.params;
	return params === undefined
		? { type: "request", requestId, method }
		: { type: "request", requestId, method, params: params as JsonValue };
}

async function dispatch(
	request: ComputerWorkerRequestMessage,
): Promise<ComputerResponsePayload> {
	switch (request.method) {
		case "computer.status":
			return service.status();
		case "computer.permissions":
			return service.permissions();
		case "computer.displays":
			return service.displays();
		case "computer.screenshot":
			return service.screenshot(parseScreenshotParams(request.params));
	}
	const exhaustive: never = request.method;
	throw new Error(`Unsupported Computer Satellite method: ${exhaustive}`);
}

self.addEventListener("message", (event) => {
	void (async () => {
		let request: ComputerWorkerRequestMessage | null = null;
		try {
			request = parseRequest(event.data);
			if (request === null) return;
			const payload = await dispatch(request);
			post({
				type: "response",
				requestId: request.requestId,
				success: true,
				payload,
			});
		} catch (error) {
			if (request === null) return;
			post({
				type: "response",
				requestId: request.requestId,
				success: false,
				error: serializeComputerError(error),
			});
		}
	})();
});

post({ type: "ready" });

function parseScreenshotParams(params?: JsonValue): ComputerScreenshotParams {
	if (params === undefined) return {};
	if (!isRecord(params)) {
		throw new Error("computer.screenshot params must be an object.");
	}
	const region = params.region;
	if (region === undefined) return {};
	if (
		!isRecord(region) ||
		typeof region.x !== "number" ||
		typeof region.y !== "number" ||
		typeof region.width !== "number" ||
		typeof region.height !== "number"
	) {
		throw new Error("computer.screenshot region must be numeric.");
	}
	return {
		region: {
			x: region.x,
			y: region.y,
			width: region.width,
			height: region.height,
		},
	};
}
