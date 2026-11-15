/**
 * Node-only pinned HTTP/HTTPS transport for the SSRF fetch guard. `nodePinnedFetch`
 * issues a request through `node:http`/`node:https` while forcing DNS resolution
 * through the caller-supplied pinned `lookup`, so the socket connects to the exact
 * address `fetch-guard.ts` already screened — closing the DNS-rebinding window
 * between the vetting lookup and the connect. Bridges web `RequestInit`/`Response`
 * to node's `request`/`IncomingMessage`: body buffering, header normalization, a
 * streamed response body, and abort-signal wiring. `nodeLookupFn` is the default
 * `node:dns` resolver the guard pins against.
 */
import { Buffer } from "node:buffer";
import { lookup as dnsLookupCallback } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import {
	type RequestOptions as HttpRequestOptions,
	type IncomingMessage,
	request as requestHttp,
} from "node:http";
import { request as requestHttps } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import type { PinnedLookupFetchLike } from "./fetch-guard.js";
import type { LookupFn } from "./ssrf.js";

export const nodeLookupFn: LookupFn = (hostname, options) =>
	dnsLookup(hostname, options);

function toRequestHeaders(headers: Headers): Record<string, string> {
	const normalized: Record<string, string> = {};
	headers.forEach((value, key) => {
		normalized[key] = value;
	});
	return normalized;
}

/**
 * Serializes a request body the way fetch would, including the content-type
 * fetch derives for it (FormData boundary, URLSearchParams, Blob type).
 */
async function requestBodyToBuffer(
	body: NonNullable<RequestInit["body"]>,
): Promise<{ bytes: Buffer; contentType: string | null }> {
	const serialized = new Response(body);
	// Read the header before the body: Bun drops the derived content-type once
	// the body is consumed.
	const contentType = serialized.headers.get("content-type");
	return {
		bytes: Buffer.from(await serialized.arrayBuffer()),
		contentType,
	};
}

function incomingMessageToWebBody(
	stream: IncomingMessage,
	cleanup: () => void,
): BodyInit {
	// Node's bridge installs error/abort listeners before the first pull and
	// owns cancellation. Hand-rolled async iterators can leave an aborted
	// response without an error listener between headers and that first pull.
	stream.once("close", cleanup);
	stream.once("end", cleanup);
	return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
}

function responseFromIncomingMessage(
	response: IncomingMessage,
	cleanup: () => void,
): Response {
	const headers = new Headers();
	for (const [key, value] of Object.entries(response.headers)) {
		if (Array.isArray(value)) {
			for (const item of value) headers.append(key, item);
		} else if (typeof value === "string") {
			headers.set(key, value);
		}
	}

	const status = response.statusCode ?? 500;
	const init = {
		status,
		statusText: response.statusMessage,
		headers,
	} satisfies ResponseInit;
	if (status === 204 || status === 205 || status === 304) {
		response.once("error", cleanup);
		response.resume();
		cleanup();
		return new Response(null, init);
	}
	return new Response(incomingMessageToWebBody(response, cleanup), init);
}

export const nodePinnedFetch: PinnedLookupFetchLike = async ({
	url,
	init,
	lookup,
}) => {
	const method = (init.method ?? "GET").toUpperCase();
	const headers = new Headers(init.headers);
	let body: Buffer | undefined;
	if (init.body !== undefined && init.body !== null) {
		const serialized = await requestBodyToBuffer(init.body);
		body = serialized.bytes;
		if (serialized.contentType && !headers.has("content-type")) {
			headers.set("content-type", serialized.contentType);
		}
		if (!headers.has("content-length")) {
			headers.set("content-length", String(body.length));
		}
	}

	const requestFn = url.protocol === "https:" ? requestHttps : requestHttp;
	// WHATWG URL keeps an IPv6 literal in brackets; node:http expects the bare
	// address, or it sends "[::1]" to DNS and as the TLS server name.
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	const requestOptions: HttpRequestOptions = {
		protocol: url.protocol,
		hostname,
		port: url.port ? Number(url.port) : undefined,
		method,
		path: `${url.pathname}${url.search}`,
		headers: toRequestHeaders(headers),
		lookup: lookup as HttpRequestOptions["lookup"],
		// SNI carries DNS names only (RFC 6066); node checks an IP literal
		// against the certificate's IP addresses by itself.
		...(url.protocol === "https:" && isIP(hostname) === 0
			? { servername: hostname }
			: undefined),
	};

	return new Promise<Response>((resolve, reject) => {
		let settled = false;
		const signal = init.signal;

		const cleanupSignal = () => {
			signal?.removeEventListener("abort", onAbort);
		};

		const rejectOnce = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanupSignal();
			reject(error);
		};

		const onAbort = () => {
			request.destroy(new DOMException("Aborted", "AbortError"));
		};

		const request = requestFn(requestOptions, (response) => {
			if (settled) return;
			// The web Response constructor throws outside 200-599; a hostile
			// upstream must surface as a transport error, not a crash.
			const status = response.statusCode;
			if (status === undefined || status < 200 || status > 599) {
				response.destroy();
				request.destroy();
				rejectOnce(new Error(`invalid upstream HTTP status ${status}`));
				return;
			}
			let built: Response;
			try {
				built = responseFromIncomingMessage(response, cleanupSignal);
			} catch (error) {
				// error-policy:J2 Tear down the socket and reject with the cause.
				response.destroy();
				request.destroy();
				rejectOnce(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			settled = true;
			resolve(built);
		});

		request.on("error", rejectOnce);

		if (signal) {
			if (signal.aborted) {
				onAbort();
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
			}
		}

		if (body) {
			request.write(body);
		}
		request.end();
	});
};

/** Validate every DNS candidate, including Node's Happy Eyeballs lookup form. */
export function createValidatedLookup(
	validate: (address: string, family: number) => void,
	resolve: LookupFunction = dnsLookupCallback,
): LookupFunction {
	return (hostname, options, callback) => {
		resolve(hostname, { ...options, all: true }, (error, result, family) => {
			if (error) {
				callback(error, []);
				return;
			}
			const addresses = Array.isArray(result)
				? result
				: [{ address: result, family: family ?? 0 }];
			try {
				if (addresses.length === 0)
					throw new Error("Destination host did not resolve");
				for (const entry of addresses) {
					if (entry.family !== 4 && entry.family !== 6)
						throw new Error("Destination address family is invalid");
					validate(entry.address, entry.family);
				}
			} catch (cause) {
				callback(cause as NodeJS.ErrnoException, []);
				return;
			}
			if (options.all) callback(null, addresses);
			else callback(null, addresses[0].address, addresses[0].family);
		});
	};
}
