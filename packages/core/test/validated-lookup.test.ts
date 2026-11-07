import type { LookupFunction } from "node:net";
import { describe, expect, it } from "vitest";
import { createValidatedLookup } from "../src/network/node-pinned-fetch";
import { assertPublicInternetAddress } from "../src/network/public-endpoint";

const lookup =
	(addresses: { address: string; family: number }[]): LookupFunction =>
	(_host, options, callback) => {
		expect(options.all).toBe(true);
		callback(null, addresses);
	};
const validate = (address: string, family: number) =>
	assertPublicInternetAddress(address, family, "test");
const resolve = (resolver: LookupFunction, all: boolean) =>
	new Promise((accept, reject) => {
		resolver("public.example", { all }, (error, address, family) =>
			error ? reject(error) : accept(all ? address : { address, family }),
		);
	});

describe("validated connect-time lookup", () => {
	it("preserves all screened addresses for Happy Eyeballs and selects one for legacy callers", async () => {
		const addresses = [
			{ address: "8.8.8.8", family: 4 },
			{ address: "2001:4860:4860::8888", family: 6 },
		];
		const resolver = createValidatedLookup(validate, lookup(addresses));
		expect(await resolve(resolver, true)).toEqual(addresses);
		expect(await resolve(resolver, false)).toEqual(addresses[0]);
	});
	it("rejects a mixed answer set before returning any connect candidate", async () => {
		const resolver = createValidatedLookup(
			validate,
			lookup([
				{ address: "8.8.8.8", family: 4 },
				{ address: "127.0.0.1", family: 4 },
			]),
		);
		await expect(resolve(resolver, true)).rejects.toThrow();
		await expect(resolve(resolver, false)).rejects.toThrow();
	});
	it("rejects empty DNS answers", async () => {
		await expect(
			resolve(createValidatedLookup(validate, lookup([])), true),
		).rejects.toThrow("did not resolve");
	});
});
