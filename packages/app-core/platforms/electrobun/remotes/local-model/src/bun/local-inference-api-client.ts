import { throwModelError } from "./errors.ts";
import type { ModelRemoteErrorCode } from "./protocol.ts";

export type LocalInferenceApiClientOptions = {
	apiBase?: string;
	token?: string | null;
};

export class LocalInferenceApiClient {
	private readonly apiBase: string | null;
	private readonly token: string | null;

	constructor(options: LocalInferenceApiClientOptions = {}) {
		this.apiBase =
			options.apiBase ??
			process.env.ELIZA_RUNTIME_API_BASE ??
			process.env.ELIZA_DESKTOP_API_BASE ??
			"http://127.0.0.1:31337";
		this.token =
			options.token ??
			process.env.ELIZA_RUNTIME_API_TOKEN ??
			process.env.ELIZA_API_TOKEN ??
			null;
	}

	status(): Promise<unknown> {
		return this.get("/api/local-inference/hub");
	}

	hub(): Promise<unknown> {
		return this.get("/api/local-inference/hub");
	}

	hardware(): Promise<unknown> {
		return this.get("/api/local-inference/hardware");
	}

	catalog(): Promise<unknown> {
		return this.get("/api/local-inference/catalog");
	}

	installed(): Promise<unknown> {
		return this.get("/api/local-inference/installed");
	}

	device(): Promise<unknown> {
		return this.get("/api/local-inference/device");
	}

	providers(): Promise<unknown> {
		return this.get("/api/local-inference/providers");
	}

	assignments(): Promise<unknown> {
		return this.get("/api/local-inference/assignments");
	}

	setAssignment(params: { slot: string; modelId?: string | null }): Promise<unknown> {
		return this.post("/api/local-inference/assignments", params);
	}

	routing(): Promise<unknown> {
		return this.get("/api/local-inference/routing");
	}

	setRouting(params: {
		slot: string;
		provider?: string | null;
		policy?: string | null;
	}): Promise<unknown> {
		if (params.provider !== undefined) {
			return this.post("/api/local-inference/routing/preferred", {
				slot: params.slot,
				provider: params.provider,
			});
		}
		return this.post("/api/local-inference/routing/policy", {
			slot: params.slot,
			policy: params.policy,
		});
	}

	useLocal(): Promise<unknown> {
		return this.setRouting({ slot: "TEXT_LARGE", provider: "eliza-local-inference" });
	}

	useCloud(): Promise<unknown> {
		return this.setRouting({ slot: "TEXT_LARGE", provider: null });
	}

	async downloads(): Promise<unknown> {
		const hub = await this.hub();
		if (isRecord(hub) && Array.isArray(hub.downloads)) return hub.downloads;
		return [];
	}

	startDownload(modelId: string): Promise<unknown> {
		return this.post("/api/local-inference/downloads", { modelId });
	}

	cancelDownload(modelId: string): Promise<unknown> {
		return this.delete(`/api/local-inference/downloads/${encodeURIComponent(modelId)}`);
	}

	active(): Promise<unknown> {
		return this.get("/api/local-inference/active");
	}

	activate(modelId: string): Promise<unknown> {
		return this.post("/api/local-inference/active", { modelId });
	}

	unload(): Promise<unknown> {
		return this.delete("/api/local-inference/active");
	}

	capabilities(): Promise<unknown> {
		return Promise.all([
			this.providers().catch((error) => ({ error })),
			this.routing().catch((error) => ({ error })),
			this.hardware().catch((error) => ({ error })),
		]).then(([providers, routing, hardware]) => ({
			providers,
			routing,
			hardware,
			directGenerationRoute: false,
			directEmbeddingRoute: false,
		}));
	}

	generate(): Promise<never> {
		throwModelError({
			code: "MODEL_GENERATION_UNAVAILABLE",
			message:
				"No direct local-inference generation HTTP route is exposed by the current runtime.",
		});
	}

	embedding(): Promise<never> {
		throwModelError({
			code: "MODEL_EMBEDDING_UNAVAILABLE",
			message:
				"No direct local-inference embedding HTTP route is exposed by the current runtime.",
		});
	}

	private get(path: string): Promise<unknown> {
		return this.request("GET", path);
	}

	private post(path: string, body: unknown): Promise<unknown> {
		return this.request("POST", path, body);
	}

	private delete(path: string): Promise<unknown> {
		return this.request("DELETE", path);
	}

	private async request(
		method: "GET" | "POST" | "DELETE",
		path: string,
		body?: unknown,
	): Promise<unknown> {
		const base = this.apiBase?.trim();
		if (!base) {
			throwModelError({
				code: "MODEL_API_BASE_MISSING",
				message: "Local inference API base is missing.",
				path,
			});
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 4_000);
		try {
			const response = await fetch(`${base.replace(/\/+$/, "")}${path}`, {
				method,
				headers: {
					Accept: "application/json",
					...(body === undefined ? {} : { "Content-Type": "application/json" }),
					...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: controller.signal,
			});
			const text = await response.text();
			const payload = parsePayload(text);
			if (!response.ok) {
				throwModelError({
					code: routeErrorCode(response.status),
					message: `Local inference request failed: ${method} ${path}`,
					path,
					status: response.status,
					details: payload,
				});
			}
			return payload;
		} catch (error) {
			if (isModelExceptionLike(error)) throw error;
			throwModelError({
				code: "MODEL_LOCAL_INFERENCE_UNAVAILABLE",
				message: `Local inference API is unavailable for ${method} ${path}.`,
				path,
				details: errorMessage(error),
			});
		} finally {
			clearTimeout(timeout);
		}
	}
}

function routeErrorCode(status: number): ModelRemoteErrorCode {
	if (status === 404 || status === 405) return "MODEL_ROUTE_UNAVAILABLE";
	return "MODEL_REQUEST_FAILED";
}

function parsePayload(text: string): unknown {
	if (text.trim().length === 0) return null;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isModelExceptionLike(value: unknown): boolean {
	return value instanceof Error && value.name === "ModelRemoteException";
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
