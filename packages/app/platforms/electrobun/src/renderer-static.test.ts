/**
 * Verifies the desktop renderer static-server response headers never allow
 * cross-origin reads. The static server embeds the local agent API base URL
 * and OWNER-level bearer token into its HTML documents, so any
 * `Access-Control-Allow-Origin` header would let an arbitrary website fetch
 * the index page and extract the credential (elizaOS/eliza#33034). The
 * renderer webview loads these responses same-origin and needs no CORS.
 */
import { describe, expect, it } from "vitest";
import {
	buildRendererStaticAssetHeaders,
	buildRendererStaticHtmlHeaders,
} from "./renderer-static";

function corsHeaderNames(headers: Record<string, string>): string[] {
	return Object.keys(headers).filter(
		(name) => name.toLowerCase() === "access-control-allow-origin",
	);
}

describe("renderer static HTML response headers", () => {
	it("serves HTML without a cross-origin read grant", () => {
		const headers = buildRendererStaticHtmlHeaders();
		expect(headers["Content-Type"]).toBe("text/html; charset=utf-8");
		expect(headers["Cache-Control"]).toBe("public, max-age=0, must-revalidate");
		expect(corsHeaderNames(headers)).toEqual([]);
	});
});

describe("renderer static asset response headers", () => {
	it("serves assets without a cross-origin read grant", () => {
		const headers = buildRendererStaticAssetHeaders({
			contentType: "application/javascript; charset=utf-8",
			cacheControl: "public, max-age=31536000, immutable",
			contentLength: 42,
		});
		expect(headers["Content-Type"]).toBe(
			"application/javascript; charset=utf-8",
		);
		expect(headers["Accept-Ranges"]).toBe("bytes");
		expect(headers["Content-Length"]).toBe("42");
		expect("Content-Encoding" in headers).toBe(false);
		expect(corsHeaderNames(headers)).toEqual([]);
	});

	it("keeps gzip and range metadata without a cross-origin read grant", () => {
		const headers = buildRendererStaticAssetHeaders({
			contentType: "model/gltf-binary",
			cacheControl: "public, max-age=86400",
			contentLength: 10,
			contentEncoding: "gzip",
			contentRange: "bytes 0-9/100",
		});
		expect(headers["Content-Encoding"]).toBe("gzip");
		expect(headers["Content-Range"]).toBe("bytes 0-9/100");
		expect(corsHeaderNames(headers)).toEqual([]);
	});
});
