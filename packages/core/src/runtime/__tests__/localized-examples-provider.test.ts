import { describe, expect, it } from "vitest";
import {
	__resetLocalizedExamplesProviderForTests,
	getLocalizedExamplesProvider,
	registerLocalizedExamplesProvider,
} from "../localized-examples-provider.ts";

const provider = async () => null;

describe("localized-examples-provider registry", () => {
	it("returns null when unregistered", () => {
		const runtime = {} as never;
		expect(getLocalizedExamplesProvider(runtime)).toBeNull();
	});

	it("returns the registered provider", () => {
		const runtime = {} as never;
		registerLocalizedExamplesProvider(runtime, provider);
		expect(getLocalizedExamplesProvider(runtime)).toBe(provider);
	});

	it("is per-runtime (WeakMap keyed)", () => {
		const a = {} as never;
		const b = {} as never;
		registerLocalizedExamplesProvider(a, provider);
		expect(getLocalizedExamplesProvider(a)).toBe(provider);
		expect(getLocalizedExamplesProvider(b)).toBeNull();
	});

	it("reset removes the provider", () => {
		const runtime = {} as never;
		registerLocalizedExamplesProvider(runtime, provider);
		__resetLocalizedExamplesProviderForTests(runtime);
		expect(getLocalizedExamplesProvider(runtime)).toBeNull();
	});
});
