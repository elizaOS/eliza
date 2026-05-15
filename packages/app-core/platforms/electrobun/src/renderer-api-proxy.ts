export function isRendererApiProxyPath(pathname: string): boolean {
	return (
		pathname.startsWith("/api/") ||
		pathname === "/ws" ||
		pathname.startsWith("/music-player")
	);
}

const BUN_SERVE_MAX_IDLE_TIMEOUT_SECONDS = 255;

function parsePositiveInteger(value: string | undefined): number | null {
	if (!value) return null;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function clampBunServeIdleTimeout(seconds: number): number {
	return Math.min(seconds, BUN_SERVE_MAX_IDLE_TIMEOUT_SECONDS);
}

export function resolveRendererProxyIdleTimeoutSeconds(
	env: Record<string, string | undefined>,
): number {
	const explicit = parsePositiveInteger(
		env.ELIZA_RENDERER_PROXY_IDLE_TIMEOUT_SECONDS,
	);
	if (explicit) return clampBunServeIdleTimeout(explicit);

	const httpTimeoutMs = parsePositiveInteger(env.ELIZA_HTTP_REQUEST_TIMEOUT_MS);
	if (httpTimeoutMs) {
		return clampBunServeIdleTimeout(Math.ceil(httpTimeoutMs / 1000));
	}

<<<<<<< HEAD
	const chatTimeoutMs = parsePositiveInteger(
		env.ELIZA_CHAT_GENERATION_TIMEOUT_MS,
	);
=======
	const chatTimeoutMs = parsePositiveInteger(env.ELIZA_CHAT_GENERATION_TIMEOUT_MS);
>>>>>>> origin/codex/fused-local-inference-latest-20260515
	if (chatTimeoutMs) {
		return clampBunServeIdleTimeout(Math.ceil((chatTimeoutMs + 60_000) / 1000));
	}

	return BUN_SERVE_MAX_IDLE_TIMEOUT_SECONDS;
}

const HOP_BY_HOP_HEADERS = [
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"host",
] as const;

function createProxyHeaders(req: Request): Headers {
	const headers = new Headers(req.headers);
	for (const header of HOP_BY_HOP_HEADERS) {
		headers.delete(header);
	}
	return headers;
}

export function createRendererApiProxyRequestInit(
	req: Request,
	_target: URL,
): RequestInit & { duplex?: "half" } {
	const headers = createProxyHeaders(req);
	const init: RequestInit & { duplex?: "half" } = {
		method: req.method,
		headers,
		redirect: "manual",
	};

	if (req.method === "GET" || req.method === "HEAD") {
		headers.delete("content-length");
		return init;
	}

	if (req.body) {
		init.body = req.body;
		init.duplex = "half";
	}

	return init;
}
