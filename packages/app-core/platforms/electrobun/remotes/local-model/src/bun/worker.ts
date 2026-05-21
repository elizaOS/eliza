import { serializeError } from "./errors.ts";
import { ModelRemoteService } from "./model-service.ts";
import type {
	JsonValue,
	LocalModelEmbeddingParams,
	LocalModelGenerateParams,
	ModelMethod,
	ModelResponsePayload,
	ModelWorkerOutboundMessage,
	ModelWorkerRequestMessage,
} from "./protocol.ts";

function post(message: ModelWorkerOutboundMessage): void {
	self.postMessage(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isModelMethod(value: string): value is ModelMethod {
	return (
		value === "model.status" ||
		value === "model.hub" ||
		value === "model.catalog" ||
		value === "model.catalog.eliza1" ||
		value === "model.eliza1.tiers" ||
		value === "model.eliza1.voice" ||
		value === "model.hf.metadata" ||
		value === "model.providers" ||
		value === "model.hardware" ||
		value === "model.installed" ||
		value === "model.download.start" ||
		value === "model.download.cancel" ||
		value === "model.downloads" ||
		value === "model.active" ||
		value === "model.activate" ||
		value === "model.unload" ||
		value === "model.assignments" ||
		value === "model.assignment.set" ||
		value === "model.routing" ||
		value === "model.routing.set" ||
		value === "model.routing.useLocal" ||
		value === "model.routing.useCloud" ||
		value === "model.generate" ||
		value === "model.embedding" ||
		value === "model.capabilities"
	);
}

function parseRequest(value: unknown): ModelWorkerRequestMessage | null {
	if (!isRecord(value)) return null;
	if (value.type !== "request") return null;
	const requestId = value.requestId;
	const method = value.method;
	if (
		(typeof requestId !== "string" && typeof requestId !== "number") ||
		typeof method !== "string" ||
		!isModelMethod(method)
	) {
		throw new Error("Invalid model request.");
	}
	const params = value.params;
	return params === undefined
		? { type: "request", requestId, method }
		: { type: "request", requestId, method, params: params as JsonValue };
}

const service = new ModelRemoteService();

async function dispatch(request: ModelWorkerRequestMessage): Promise<ModelResponsePayload> {
	switch (request.method) {
		case "model.status":
			return service.status(optionalObject(request.params));
		case "model.hub":
			return service.hub(optionalObject(request.params));
		case "model.catalog":
			return service.catalog(optionalObject(request.params));
		case "model.catalog.eliza1":
			return service.eliza1Catalog();
		case "model.eliza1.tiers":
			return service.eliza1Tiers();
		case "model.eliza1.voice":
			return service.eliza1Voice();
		case "model.hf.metadata":
			return service.hfMetadata();
		case "model.providers":
			return service.providers(optionalObject(request.params));
		case "model.hardware":
			return service.hardware(optionalObject(request.params));
		case "model.installed":
			return service.installed(optionalObject(request.params));
		case "model.download.start":
			return service.startDownload(modelIdParams(request.params));
		case "model.download.cancel":
			return service.cancelDownload(modelIdParams(request.params));
		case "model.downloads":
			return service.downloads(optionalObject(request.params));
		case "model.active":
			return service.active(optionalObject(request.params));
		case "model.activate":
			return service.activate(modelIdParams(request.params));
		case "model.unload":
			return service.unload(optionalObject(request.params));
		case "model.assignments":
			return service.assignments(optionalObject(request.params));
		case "model.assignment.set":
			return service.setAssignment(assignmentParams(request.params));
		case "model.routing":
			return service.routing(optionalObject(request.params));
		case "model.routing.set":
			return service.setRouting(routingParams(request.params));
		case "model.routing.useLocal":
			return service.useLocal(optionalObject(request.params));
		case "model.routing.useCloud":
			return service.useCloud(optionalObject(request.params));
		case "model.generate":
			return service.generate(generateParams(request.params));
		case "model.embedding":
			return service.embedding(embeddingParams(request.params));
		case "model.capabilities":
			return service.capabilities(optionalObject(request.params));
	}
	const exhaustive: never = request.method;
	throw new Error(`Unsupported model method: ${exhaustive}`);
}

function optionalObject(params?: JsonValue): { apiBase?: string } {
	if (params === undefined) return {};
	if (!isRecord(params)) throw new Error("Params must be an object.");
	const apiBase = params.apiBase;
	return typeof apiBase === "string" ? { apiBase } : {};
}

function modelIdParams(params?: JsonValue): { apiBase?: string; modelId: string } {
	const base = optionalObject(params);
	if (!isRecord(params) || typeof params.modelId !== "string") {
		throw new Error("modelId is required.");
	}
	return { ...base, modelId: params.modelId };
}

function assignmentParams(params?: JsonValue): {
	apiBase?: string;
	slot: string;
	modelId?: string | null;
} {
	const base = optionalObject(params);
	if (!isRecord(params) || typeof params.slot !== "string") {
		throw new Error("slot is required.");
	}
	const modelId =
		typeof params.modelId === "string" || params.modelId === null
			? params.modelId
			: undefined;
	return { ...base, slot: params.slot, modelId };
}

function routingParams(params?: JsonValue): {
	apiBase?: string;
	slot: string;
	provider?: string | null;
	policy?: string | null;
} {
	const base = optionalObject(params);
	if (!isRecord(params) || typeof params.slot !== "string") {
		throw new Error("slot is required.");
	}
	const provider =
		typeof params.provider === "string" || params.provider === null
			? params.provider
			: undefined;
	const policy =
		typeof params.policy === "string" || params.policy === null
			? params.policy
			: undefined;
	return { ...base, slot: params.slot, provider, policy };
}

function generateParams(
	params?: JsonValue,
): LocalModelGenerateParams & { apiBase?: string } {
	const base = optionalObject(params);
	if (!isRecord(params)) throw new Error("model.generate params are required.");
	const prompt = typeof params.prompt === "string" ? params.prompt : "";
	const modelId = typeof params.modelId === "string" ? params.modelId : undefined;
	const systemPrompt =
		typeof params.systemPrompt === "string" ? params.systemPrompt : undefined;
	const temperature =
		typeof params.temperature === "number" ? params.temperature : undefined;
	const maxTokens = typeof params.maxTokens === "number" ? params.maxTokens : undefined;
	const topP = typeof params.topP === "number" ? params.topP : undefined;
	return {
		...base,
		prompt,
		modelId,
		systemPrompt,
		temperature,
		maxTokens,
		topP,
	};
}

function embeddingParams(
	params?: JsonValue,
): LocalModelEmbeddingParams & { apiBase?: string } {
	const base = optionalObject(params);
	if (!isRecord(params) || typeof params.input !== "string") {
		throw new Error("model.embedding input is required.");
	}
	const modelId = typeof params.modelId === "string" ? params.modelId : undefined;
	return { ...base, modelId, input: params.input };
}

self.addEventListener("message", (event) => {
	void (async () => {
		let request: ModelWorkerRequestMessage | null = null;
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
				error: serializeError(error),
			});
		}
	})();
});

post({ type: "ready" });
