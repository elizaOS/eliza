/** A mobile build that stubs `phonemizer` must leave Kokoro on its bundled G2P. */
import { expect, it, vi } from "vitest";

vi.mock("phonemizer", () => {
	const unavailable = () => {
		throw Object.assign(new Error("unavailable"), {
			code: "MOBILE_CAPABILITY_UNAVAILABLE",
		});
	};
	// The shape the bundle gives a namespace import of the null-plugin stub:
	// no own named exports, and a default that answers every property.
	const stub = new Proxy(
		{},
		{ get: (_t, prop) => (prop === "__mobileStub" ? true : unavailable) },
	);
	return { default: stub, phonemize: undefined, __mobileStub: undefined };
});

it("treats a stubbed phonemizer as absent", async () => {
	const { FallbackG2PPhonemizer, NpmPhonemizePhonemizer, resolvePhonemizer } =
		await import("../phonemizer");
	expect(await NpmPhonemizePhonemizer.tryLoad()).toBeNull();
	expect(await resolvePhonemizer()).toBeInstanceOf(FallbackG2PPhonemizer);
});
