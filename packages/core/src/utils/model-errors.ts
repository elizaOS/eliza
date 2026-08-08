/**
 * Classifies model-call errors as transient (worth retrying) by scanning the
 * error message for known rate-limit, overload, timeout, and 5xx signatures.
 * Retry logic around model invocations consumes this to decide whether to back
 * off and try again versus surface the failure.
 */
const TRANSIENT_MODEL_ERROR_PATTERNS = [
	"service temporarily unavailable",
	"temporarily unavailable",
	"rate limit",
	"too many requests",
	"overloaded",
	"socket connection was closed unexpectedly",
	"econnreset",
	"econnrefused",
	"etimedout",
	"timeout",
	"timed out",
	"529",
	"503",
	"502",
	"504",
];

export function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function isTransientModelError(error: unknown): boolean {
	const message = getErrorMessage(error).toLowerCase();
	return TRANSIENT_MODEL_ERROR_PATTERNS.some((pattern) =>
		message.includes(pattern),
	);
}

// Node/undici surface these on `error.code` (or `error.cause.code`) when a
// request never reaches an HTTP response — the transport failed. Structural
// signal, so we never guess a network failure from message text.
const NETWORK_ERROR_CODES = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"ECONNABORTED",
	"EPIPE",
	"ETIMEDOUT",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
	"UND_ERR_SOCKET",
]);

// Walk the bounded error graph a provider failure can arrive wrapped in: the
// `.cause` chain (plugin-anthropic re-wraps the AI SDK `APICallError` in a
// message-carrying Error and preserves the original on `.cause`) and the AI SDK
// `RetryError` envelope (`.lastError` / `.errors[]`, populated once retries
// exhaust). Only OBJECT nodes are traversed — `SchemaValidationFailedError`
// carries an `errors: string[]` of validation messages, and those strings must
// not be mistaken for wrapped provider errors.
function* modelErrorChain(error: unknown): Generator<object> {
	const seen = new Set<unknown>();
	const stack: unknown[] = [error];
	while (stack.length > 0 && seen.size < 12) {
		const node = stack.pop();
		if (typeof node !== "object" || node === null || seen.has(node)) continue;
		seen.add(node);
		yield node;
		const c = node as {
			cause?: unknown;
			lastError?: unknown;
			errors?: unknown;
		};
		if (c.cause !== undefined) stack.push(c.cause);
		if (c.lastError !== undefined) stack.push(c.lastError);
		if (Array.isArray(c.errors)) {
			for (const e of c.errors) stack.push(e);
		}
	}
}

function readHttpStatus(node: object): number | undefined {
	const raw =
		(node as { statusCode?: unknown; status?: unknown }).statusCode ??
		(node as { status?: unknown }).status;
	if (typeof raw === "number" && Number.isFinite(raw)) return raw;
	if (typeof raw === "string") {
		const n = Number(raw);
		if (Number.isFinite(n) && n > 0) return n;
	}
	return undefined;
}

/**
 * HTTP status carried by a model/provider error, or undefined when the error
 * carries none. Mirrors the canonical structural signal in
 * `services/message/fallback-reply.ts`: the AI SDK records the upstream status
 * on `APICallError.statusCode` (a `RetryError` wraps it on `.lastError` /
 * `.errors` once retries exhaust); legacy OpenAI-style SDK errors expose
 * `.status`. Read the status, never scan the message text.
 */
export function modelProviderErrorStatus(error: unknown): number | undefined {
	for (const node of modelErrorChain(error)) {
		const status = readHttpStatus(node);
		if (status !== undefined) return status;
	}
	return undefined;
}

/**
 * Structured diagnostic detail for a model/provider failure: the HTTP status,
 * the provider's own error message parsed out of the response body, and a
 * bounded excerpt of that body. The AI SDK keeps the raw body on
 * `APICallError.responseBody` but derives `error.message` from the OpenAI
 * `{"error": {...}}` envelope only — providers that return a FLAT error shape
 * (Cerebras: `{"message", "type", "param", "code"}`) surface as a bare
 * statusText ("Bad Request") with the real cause silently dropped. This
 * extractor recovers that cause so reportError context, logs, and trajectory
 * records can carry it.
 */
export interface ModelProviderErrorDetail {
	status?: number;
	providerMessage?: string;
	responseBodyExcerpt?: string;
	url?: string;
}

const RESPONSE_BODY_EXCERPT_MAX_CHARS = 400;

function providerMessageFromBody(body: string): string | undefined {
	try {
		const parsed = JSON.parse(body) as {
			message?: unknown;
			error?: { message?: unknown } | string;
			detail?: unknown;
		};
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const candidates = [
			parsed.message,
			typeof parsed.error === "object" && parsed.error !== null
				? parsed.error.message
				: parsed.error,
			parsed.detail,
		];
		for (const candidate of candidates) {
			if (typeof candidate === "string" && candidate.trim().length > 0) {
				return candidate.trim();
			}
		}
		return undefined;
	} catch {
		// error-policy:J3 untrusted-input sanitizing — a non-JSON body has no
		// structured message; the caller falls back to the raw excerpt.
		return undefined;
	}
}

/**
 * Best-effort extraction of {@link ModelProviderErrorDetail} from a thrown
 * model-call error, walking the same bounded `.cause`/`RetryError` graph as
 * {@link modelProviderErrorStatus}. Returns undefined when the chain carries
 * neither a status nor a response body, so callers can spread it into context
 * objects without manufacturing empty fields.
 */
export function modelProviderErrorDetail(
	error: unknown,
): ModelProviderErrorDetail | undefined {
	let status: number | undefined;
	let providerMessage: string | undefined;
	let responseBodyExcerpt: string | undefined;
	let url: string | undefined;
	for (const node of modelErrorChain(error)) {
		status ??= readHttpStatus(node);
		if (responseBodyExcerpt === undefined) {
			const body = (node as { responseBody?: unknown }).responseBody;
			if (typeof body === "string" && body.trim().length > 0) {
				responseBodyExcerpt = body
					.replace(/\s+/g, " ")
					.trim()
					.slice(0, RESPONSE_BODY_EXCERPT_MAX_CHARS);
				providerMessage = providerMessageFromBody(body);
			}
		}
		if (url === undefined) {
			const rawUrl = (node as { url?: unknown }).url;
			if (typeof rawUrl === "string" && rawUrl.length > 0) url = rawUrl;
		}
	}
	if (
		status === undefined &&
		providerMessage === undefined &&
		responseBodyExcerpt === undefined
	) {
		return undefined;
	}
	return {
		...(status !== undefined ? { status } : {}),
		...(providerMessage !== undefined ? { providerMessage } : {}),
		...(responseBodyExcerpt !== undefined ? { responseBodyExcerpt } : {}),
		...(url !== undefined ? { url } : {}),
	};
}

/**
 * True when a thrown model-call error is an EXPECTED provider/transport failure
 * — the provider returned an HTTP error status (>= 400) or the request failed
 * at the network layer — as opposed to a programmer or schema-validation error
 * (`TypeError`, `SchemaValidationFailedError`) that indicates a real bug and
 * must propagate. Purely structural: HTTP status and network error codes, never
 * a message-substring guess. Used to gate the planner-loop's post-tool
 * evaluator relay so a transient provider failure degrades to an already
 * completed tool's truthful output while genuine bugs still surface.
 */
export function isModelProviderError(error: unknown): boolean {
	for (const node of modelErrorChain(error)) {
		const status = readHttpStatus(node);
		if (typeof status === "number" && status >= 400) return true;
		const code = (node as { code?: unknown }).code;
		if (typeof code === "string" && NETWORK_ERROR_CODES.has(code)) return true;
	}
	return false;
}
