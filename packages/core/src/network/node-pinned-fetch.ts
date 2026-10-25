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
import type { LookupFunction } from "node:net";
import { Readable } from "node:stream";
import type { PinnedLookupFetchLike } from "./fetch-guard.js";
import type { LookupFn } from "./ssrf.js";

export const nodeLookupFn: LookupFn = async (hostname, options) => {
	const results = await dnsLookup(hostname, options);
	return results.map((entry) => ({
		address: entry.address,
		family: entry.family,
	}));
};

function toRequestHeaders(headers: Headers): Record<string, string> {
	const normalized: Record<string, string> = {};
	headers.forEach((value, key) => {
		normalized[key] = value;
	});
	return normalized;
}

async function requestBodyToBuffer(
	body: NonNullable<RequestInit["body"]>,
): Promise<Buffer> {
	if (typeof body === "string") return Buffer.from(body);
	if (body instanceof ArrayBuffer) return Buffer.from(body);
	if (ArrayBuffer.isView(body)) {
		return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
	}
	return Buffer.from(await new Response(body).arrayBuffer());
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
		body = await requestBodyToBuffer(init.body);
		if (!headers.has("content-length")) {
			headers.set("content-length", String(body.length));
		}
	}

	const requestFn = url.protocol === "https:" ? requestHttps : requestHttp;
	const requestOptions: HttpRequestOptions = {
		protocol: url.protocol,
		hostname: url.hostname,
		port: url.port ? Number(url.port) : undefined,
		method,
		path: `${url.pathname}${url.search}`,
		headers: toRequestHeaders(headers),
		lookup: lookup as HttpRequestOptions["lookup"],
		...(url.protocol === "https:" ? { servername: url.hostname } : undefined),
	};

	return new Promise<Response>((resolve, reject) => {
		let settled = false;
		const signal = init.signal ?? undefined;

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
			settled = true;
			resolve(responseFromIncomingMessage(response, cleanupSignal));
		});

		request.on("error", (error) => {
			rejectOnce(error);
		});

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
