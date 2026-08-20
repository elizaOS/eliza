/**
 * Bounded, SSRF-guarded JSON-over-HTTP transport shared by managed-provider
 * adapters. Every request is pinned to the resolved connection's origin, uses
 * core's DNS-pinned guarded fetch with redirects rejected, enforces a wall
 * deadline and response byte limit, and decodes bodies through a caller
 * supplied schema so provider bytes never escape unvalidated. Failures are
 * classified into the `ManagedProviderError` taxonomy; adapters wrap them into
 * domain errors at their own boundary.
 *
 * Extracted from the plugin-maps JSON adapter, which is the reference
 * migration; behavior changes here must keep that plugin's contract tests
 * green.
 */

import { logger } from "../../logger";
import {
	fetchWithSsrfGuard,
	type GuardedFetchOptions,
	isBlockedHostname,
	isPrivateIpAddress,
	SsrfBlockedError,
} from "../../network";
import type { ResolvedProviderConnection } from "./connection";
import { ManagedProviderError } from "./errors";

/** Structural zod-compatible schema seam so core does not depend on zod here. */
export interface ProviderResponseSchema<T> {
	safeParse(
		value: unknown,
	): { success: true; data: T } | { success: false; error: unknown };
}

export interface ManagedProviderHttpClientOptions {
	connection: ResolvedProviderConnection;
	/** Header carrying the opaque connection id; default x-eliza-connection-id. */
	connectionIdHeader?: string;
	timeoutMs?: number;
	responseByteLimit?: number;
	/** Explicit transport seam for deterministic SSRF/adversarial tests only. */
	testTransport?: Pick<
		GuardedFetchOptions,
		"fetchImpl" | "pinnedFetchImpl" | "lookupFn"
	>;
	/** Allows an injected test transport to reach its loopback fake upstream. */
	allowPrivateNetworkForTests?: boolean;
}

export const MANAGED_PROVIDER_DEFAULT_TIMEOUT_MS = 10_000;
export const MANAGED_PROVIDER_MIN_TIMEOUT_MS = 100;
export const MANAGED_PROVIDER_MAX_TIMEOUT_MS = 60_000;
export const MANAGED_PROVIDER_DEFAULT_RESPONSE_BYTES = 1024 * 1024;
export const MANAGED_PROVIDER_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_CONNECTION_ID_HEADER = "x-eliza-connection-id";
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

interface RequestDeadline {
	signal: AbortSignal;
	dispose(): void;
}

function requestDeadline(timeoutMs: number): RequestDeadline {
	const controller = new AbortController();
	const timeout = setTimeout(
		() =>
			controller.abort(
				new DOMException("Provider deadline elapsed", "TimeoutError"),
			),
		timeoutMs,
	);
	timeout.unref?.();
	return {
		signal: controller.signal,
		dispose: () => clearTimeout(timeout),
	};
}

function observeTeardown(operation: Promise<unknown>, surface: string): void {
	// error-policy:J6 Teardown is intentionally non-blocking; a redacted debug
	// observation keeps cancellation failures visible without delaying results.
	void operation.catch((error) => {
		logger.debug(
			{
				errorName: error instanceof Error ? error.name : typeof error,
				surface,
			},
			"[ManagedProviderHttpClient] Response-stream teardown did not complete cleanly",
		);
	});
}

function cancelBody(response: Response, reason: string): void {
	// error-policy:J6 Cancellation is teardown only and must never delay the
	// typed terminal result from an untrusted response stream.
	if (response.body) observeTeardown(response.body.cancel(reason), reason);
}

function retryAfterMs(response: Response): number | undefined {
	const raw = response.headers.get("retry-after");
	if (!raw) return undefined;
	const seconds = Number(raw);
	if (Number.isFinite(seconds) && seconds >= 0)
		return Math.round(seconds * 1_000);
	const date = Date.parse(raw);
	return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function classifyProviderError(
	response: Response,
	body: unknown,
): ManagedProviderError {
	const providerCode =
		body && typeof body === "object" && "code" in body
			? String((body as { code?: unknown }).code)
			: "";
	if (
		(response.status === 401 || response.status === 403) &&
		providerCode === "credential_revoked"
	) {
		return new ManagedProviderError("The provider connection was revoked.", {
			code: "AUTH_REVOKED",
			context: { status: response.status },
		});
	}
	if (response.status === 401) {
		return new ManagedProviderError("The provider connection has expired.", {
			code: "AUTH_EXPIRED",
			context: { status: response.status },
		});
	}
	if (response.status === 429) {
		return new ManagedProviderError("The provider is rate limited.", {
			code: "RATE_LIMITED",
			retryAfterMs: retryAfterMs(response),
			context: { status: response.status },
		});
	}
	if (response.status >= 500) {
		return new ManagedProviderError("The provider failed.", {
			code: "PROVIDER_FAILURE",
			context: { status: response.status },
		});
	}
	return new ManagedProviderError("The provider rejected the request.", {
		code: "PROVIDER_REJECTED",
		context: { status: response.status },
	});
}

export class ManagedProviderHttpClient {
	readonly connection: ResolvedProviderConnection;
	private readonly connectionIdHeader: string;
	private readonly timeoutMs: number;
	private readonly responseByteLimit: number;
	private readonly testTransport?: ManagedProviderHttpClientOptions["testTransport"];
	private readonly allowPrivateNetworkForTests: boolean;

	constructor(options: ManagedProviderHttpClientOptions) {
		const connection = options.connection;
		const allowPrivateTest = options.allowPrivateNetworkForTests === true;
		if (allowPrivateTest && !options.testTransport?.fetchImpl) {
			throw new ManagedProviderError(
				"Private-network provider endpoints require an explicit injected test transport.",
				{ code: "INVALID_INPUT" },
			);
		}
		const baseUrl = new URL(connection.baseOrigin);
		if (
			baseUrl.protocol !== "https:" &&
			!(allowPrivateTest && baseUrl.protocol === "http:")
		) {
			throw new ManagedProviderError("The provider endpoint must use HTTPS.", {
				code: "INVALID_INPUT",
			});
		}
		if (
			!allowPrivateTest &&
			(isBlockedHostname(baseUrl.hostname) ||
				isPrivateIpAddress(baseUrl.hostname))
		) {
			throw new ManagedProviderError(
				"The provider endpoint is not a public origin.",
				{ code: "ENDPOINT_BLOCKED" },
			);
		}
		const connectionIdHeader =
			options.connectionIdHeader ?? DEFAULT_CONNECTION_ID_HEADER;
		if (!HEADER_NAME_PATTERN.test(connectionIdHeader)) {
			throw new ManagedProviderError(
				"The connection id header name is invalid.",
				{ code: "INVALID_INPUT" },
			);
		}
		const timeoutMs = options.timeoutMs ?? MANAGED_PROVIDER_DEFAULT_TIMEOUT_MS;
		if (
			!Number.isInteger(timeoutMs) ||
			timeoutMs < MANAGED_PROVIDER_MIN_TIMEOUT_MS ||
			timeoutMs > MANAGED_PROVIDER_MAX_TIMEOUT_MS
		) {
			throw new ManagedProviderError(
				`The provider timeout must be an integer from ${MANAGED_PROVIDER_MIN_TIMEOUT_MS} to ${MANAGED_PROVIDER_MAX_TIMEOUT_MS} ms.`,
				{ code: "INVALID_INPUT" },
			);
		}
		const responseByteLimit =
			options.responseByteLimit ?? MANAGED_PROVIDER_DEFAULT_RESPONSE_BYTES;
		if (
			!Number.isInteger(responseByteLimit) ||
			responseByteLimit < 1 ||
			responseByteLimit > MANAGED_PROVIDER_MAX_RESPONSE_BYTES
		) {
			throw new ManagedProviderError(
				"The provider response byte limit is invalid.",
				{ code: "INVALID_INPUT" },
			);
		}
		this.connection = connection;
		this.connectionIdHeader = connectionIdHeader;
		this.timeoutMs = timeoutMs;
		this.responseByteLimit = responseByteLimit;
		this.testTransport = options.testTransport;
		this.allowPrivateNetworkForTests = allowPrivateTest;
	}

	/** Builds a request URL pinned to the connection origin. */
	url(path: string): URL {
		const url = new URL(path, this.connection.baseOrigin);
		if (url.origin !== this.connection.baseOrigin) {
			throw new ManagedProviderError(
				"The provider request escaped the configured origin.",
				{ code: "ENDPOINT_BLOCKED" },
			);
		}
		return url;
	}

	/** Fetches and decodes one JSON response against the supplied schema. */
	async requestJson<T>(
		url: URL,
		init: RequestInit,
		schema: ProviderResponseSchema<T>,
	): Promise<T> {
		const result = await this.requestOptionalJson(url, init, schema, {
			notFoundIsNull: false,
		});
		if (result === null) {
			throw new ManagedProviderError(
				"The provider response was unexpectedly empty.",
				{ code: "MALFORMED_RESPONSE" },
			);
		}
		return result;
	}

	/**
	 * Like {@link requestJson} but, when configured, translates an upstream 404
	 * into a designed-null result instead of a rejection.
	 */
	async requestOptionalJson<T>(
		url: URL,
		init: RequestInit,
		schema: ProviderResponseSchema<T>,
		options: { notFoundIsNull: boolean } = { notFoundIsNull: true },
	): Promise<T | null> {
		const deadline = requestDeadline(this.timeoutMs);
		try {
			const guarded = await this.fetchGuarded(url, init, deadline);
			try {
				if (options.notFoundIsNull && guarded.response.status === 404) {
					cancelBody(guarded.response, "provider resource was not found");
					return null;
				}
				return await this.decodeResponse(guarded.response, schema, deadline);
			} finally {
				await guarded.release();
			}
		} finally {
			deadline.dispose();
		}
	}

	private async fetchGuarded(
		url: URL,
		init: RequestInit,
		deadline: RequestDeadline,
	): ReturnType<typeof fetchWithSsrfGuard> {
		if (url.origin !== this.connection.baseOrigin) {
			throw new ManagedProviderError(
				"The provider request escaped the configured origin.",
				{ code: "ENDPOINT_BLOCKED" },
			);
		}
		const headers = new Headers(init.headers);
		if (this.connection.credential)
			headers.set("authorization", `Bearer ${this.connection.credential}`);
		headers.set(this.connectionIdHeader, this.connection.connectionId);
		try {
			return await fetchWithSsrfGuard({
				url: url.href,
				init: { ...init, headers, redirect: "manual", signal: deadline.signal },
				maxRedirects: 0,
				timeoutMs: this.timeoutMs,
				signal: deadline.signal,
				policy: this.allowPrivateNetworkForTests
					? { allowPrivateNetwork: true }
					: undefined,
				...this.testTransport,
			});
		} catch (error) {
			// error-policy:J2 Add a typed provider/network classification while
			// preserving the original transport failure as the cause.
			if (
				deadline.signal.aborted ||
				(error instanceof Error &&
					(error.name === "AbortError" || error.name === "TimeoutError"))
			) {
				throw new ManagedProviderError("The provider timed out.", {
					code: "PROVIDER_TIMEOUT",
					cause: error,
				});
			}
			if (error instanceof SsrfBlockedError) {
				throw new ManagedProviderError(
					"The provider endpoint was blocked by network policy.",
					{ code: "ENDPOINT_BLOCKED", cause: error },
				);
			}
			throw new ManagedProviderError("The provider connection failed.", {
				code: "PROVIDER_NETWORK",
				cause: error,
			});
		}
	}

	private async readBoundedBody(
		response: Response,
		deadline: RequestDeadline,
	): Promise<string> {
		const declared = response.headers.get("content-length");
		if (
			declared &&
			/^\d+$/.test(declared) &&
			Number(declared) > this.responseByteLimit
		) {
			cancelBody(response, "provider declared response exceeded byte limit");
			throw new ManagedProviderError(
				"The provider response exceeded the byte limit.",
				{
					code: "RESPONSE_TOO_LARGE",
					context: { status: response.status, limit: this.responseByteLimit },
				},
			);
		}
		if (!response.body) return "";
		const reader = response.body.getReader();
		const decoder = new TextDecoder("utf-8", { fatal: true });
		let body = "";
		let bytes = 0;
		try {
			while (true) {
				const chunk = await new Promise<ReadableStreamReadResult<Uint8Array>>(
					(resolve, reject) => {
						const onAbort = () =>
							reject(
								deadline.signal.reason ??
									new DOMException("Provider deadline elapsed", "TimeoutError"),
							);
						if (deadline.signal.aborted) return onAbort();
						deadline.signal.addEventListener("abort", onAbort, {
							once: true,
						});
						void reader
							.read()
							.then(resolve, reject)
							.finally(() =>
								deadline.signal.removeEventListener("abort", onAbort),
							);
					},
				);
				if (chunk.done) break;
				bytes += chunk.value.byteLength;
				if (bytes > this.responseByteLimit) {
					observeTeardown(
						reader.cancel("provider response exceeded byte limit"),
						"response-too-large",
					);
					throw new ManagedProviderError(
						"The provider response exceeded the byte limit.",
						{
							code: "RESPONSE_TOO_LARGE",
							context: {
								status: response.status,
								limit: this.responseByteLimit,
							},
						},
					);
				}
				body += decoder.decode(chunk.value, { stream: true });
			}
			body += decoder.decode();
			return body;
		} catch (error) {
			if (error instanceof ManagedProviderError) throw error;
			if (
				deadline.signal.aborted ||
				(error instanceof Error &&
					(error.name === "AbortError" || error.name === "TimeoutError"))
			) {
				observeTeardown(
					reader.cancel("provider response deadline elapsed"),
					"response-deadline",
				);
				throw new ManagedProviderError("The provider timed out.", {
					code: "PROVIDER_TIMEOUT",
					cause: error,
					context: { status: response.status },
				});
			}
			// error-policy:J2 Provider bytes are untrusted; preserve bounded read
			// and UTF-8 failures without retaining or exposing response content.
			throw new ManagedProviderError(
				"The provider response body could not be read.",
				{
					code: "MALFORMED_RESPONSE",
					cause: error,
					context: { status: response.status },
				},
			);
		} finally {
			try {
				reader.releaseLock();
			} catch (error) {
				// error-policy:J6 A pending untrusted read owns the lock until its
				// non-blocking cancellation settles; terminal classification is fixed.
				logger.debug(
					{
						errorName: error instanceof Error ? error.name : typeof error,
						surface: "reader-release-lock",
					},
					"[ManagedProviderHttpClient] Response reader lock remained pending during teardown",
				);
			}
		}
	}

	private async decodeResponse<T>(
		response: Response,
		schema: ProviderResponseSchema<T>,
		deadline: RequestDeadline,
	): Promise<T> {
		if (!response.ok) {
			let errorBody: unknown;
			if (response.status === 401 || response.status === 403) {
				try {
					const text = await this.readBoundedBody(response, deadline);
					if (text) errorBody = JSON.parse(text);
				} catch {
					// error-policy:J3 Diagnostic bytes are optional; once headers carry
					// an error status, timeout/size/parse failures cannot replace it.
					errorBody = undefined;
				}
			} else {
				cancelBody(response, "provider returned an error status");
			}
			throw classifyProviderError(response, errorBody);
		}
		const text = await this.readBoundedBody(response, deadline);
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch (error) {
			// error-policy:J2 Provider bytes are untrusted; preserve the JSON
			// parse failure without retaining or exposing the response body.
			throw new ManagedProviderError("The provider returned malformed JSON.", {
				code: "MALFORMED_RESPONSE",
				cause: error,
				context: { status: response.status },
			});
		}
		const parsed = schema.safeParse(body);
		if (!parsed.success) {
			throw new ManagedProviderError(
				"The provider response did not match the contract.",
				{
					code: "MALFORMED_RESPONSE",
					cause: parsed.error,
					context: { status: response.status },
				},
			);
		}
		return parsed.data;
	}
}
