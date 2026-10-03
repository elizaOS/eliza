import { describe, expect, it } from "vitest";
import { isTrustedLocalRequest } from "./loopback-trust.js";

const policy = { localAuthRequired: false, cloudProvisioned: false };
const request = {
	headers: { host: "localhost:2138", origin: "http://localhost:2138" },
	socket: { remoteAddress: "127.0.0.1" },
};

describe("same-machine request trust", () => {
	it("accepts matching loopback authority only when host policy permits", () => {
		expect(isTrustedLocalRequest(request, policy)).toBe(true);
		expect(
			isTrustedLocalRequest(request, { ...policy, localAuthRequired: true }),
		).toBe(false);
		expect(
			isTrustedLocalRequest(request, { ...policy, cloudProvisioned: true }),
		).toBe(false);
	});
	it("fails closed without a verified loopback peer", () => {
		expect(isTrustedLocalRequest({ headers: request.headers }, policy)).toBe(
			false,
		);
		expect(
			isTrustedLocalRequest(
				{ ...request, socket: { remoteAddress: "203.0.113.1" } },
				policy,
			),
		).toBe(false);
	});
	it.each([
		{ host: "127.0.0.1.evil.example", origin: "http://127.0.0.1.evil.example" },
		{ ...request.headers, origin: "http://localhost:9999" },
		{ ...request.headers, "sec-fetch-site": "cross-site" },
		{ ...request.headers, "x-forwarded-for": "203.0.113.1" },
	])("rejects hostile browser or proxy metadata: %j", (headers) => {
		expect(isTrustedLocalRequest({ ...request, headers }, policy)).toBe(false);
	});
});
