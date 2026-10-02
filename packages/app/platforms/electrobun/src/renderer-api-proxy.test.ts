/**
 * Verifies the desktop renderer server's DNS-rebinding Host gate against the
 * reported attack (elizaOS/eliza#33036): a rebound page resolves an attacker
 * domain to 127.0.0.1 and reaches this loopback listener same-origin, so any
 * non-loopback request authority must be rejected before the server serves
 * static bytes or proxies into the OWNER-trusting agent API. Deterministic
 * decision-matrix harness over the real exported gate.
 */
import { describe, expect, it } from "vitest";
import { isRendererServerRequestHostAllowed } from "./renderer-api-proxy";

describe("renderer server request Host gate", () => {
	it("admits the authorities the desktop webview actually sends", () => {
		expect(isRendererServerRequestHostAllowed("127.0.0.1:5174")).toBe(true);
		expect(isRendererServerRequestHostAllowed("localhost:5174")).toBe(true);
		expect(isRendererServerRequestHostAllowed("LOCALHOST:5175")).toBe(true);
		expect(isRendererServerRequestHostAllowed("[::1]:5174")).toBe(true);
	});

	it("admits a request without a Host header", () => {
		// HTTP/1.0 clients name no authority at all; the agent API's own
		// loopback-trust treats an absent Host the same way, so the renderer
		// gate must not introduce a stricter rule that breaks such clients.
		expect(isRendererServerRequestHostAllowed(null)).toBe(true);
		expect(isRendererServerRequestHostAllowed(undefined)).toBe(true);
		expect(isRendererServerRequestHostAllowed("")).toBe(true);
	});

	it("rejects the rebinding authority from the reported attack", () => {
		expect(
			isRendererServerRequestHostAllowed("7f000001.c0a8010a.rbndr.us:5174"),
		).toBe(false);
	});

	it("rejects loopback lookalike and partial-match domains", () => {
		// Public subdomains of 127.0.0.1.nip.io resolve to loopback while the
		// browser keeps the attacker's name in Host; a startsWith check would
		// admit them.
		expect(isRendererServerRequestHostAllowed("127.0.0.1.nip.io:5174")).toBe(
			false,
		);
		expect(isRendererServerRequestHostAllowed("sub.localhost:5174")).toBe(
			false,
		);
	});

	it("rejects non-loopback request authorities", () => {
		expect(isRendererServerRequestHostAllowed("192.168.1.10:5174")).toBe(false);
		expect(isRendererServerRequestHostAllowed("evil.example.com:5174")).toBe(
			false,
		);
	});
});
