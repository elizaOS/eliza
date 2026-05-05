import { describe, expect, it } from "vitest";
import { createPinnedLookup, type LookupAddress } from "./ssrf.ts";

describe("createPinnedLookup", () => {
	it("returns the Node single-address callback shape by default", async () => {
		const lookup = createPinnedLookup({
			hostname: "example.com",
			addresses: ["203.0.113.10"],
		}) as (
			hostname: string,
			callback: (error: Error | null, address: string, family?: number) => void,
		) => void;

		await new Promise<void>((resolve, reject) => {
			lookup("example.com", (error, address, family) => {
				if (error) {
					reject(error);
					return;
				}
				expect(address).toBe("203.0.113.10");
				expect(family).toBe(4);
				resolve();
			});
		});
	});

	it("returns the Node all-address callback shape when requested", async () => {
		const lookup = createPinnedLookup({
			hostname: "example.com",
			addresses: ["203.0.113.10"],
		}) as (
			hostname: string,
			options: { all: true },
			callback: (error: Error | null, addresses: LookupAddress[]) => void,
		) => void;

		await new Promise<void>((resolve, reject) => {
			lookup("example.com", { all: true }, (error, addresses) => {
				if (error) {
					reject(error);
					return;
				}
				expect(addresses).toEqual([{ address: "203.0.113.10", family: 4 }]);
				resolve();
			});
		});
	});
});
