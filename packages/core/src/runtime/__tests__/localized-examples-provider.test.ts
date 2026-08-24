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

describe("localized-examples-provider registration lifecycle", () => {
	it("re-registration replaces the previous provider", () => {
		const runtime = {} as never;
		const first = async () => null;
		const second = async () => null;
		registerLocalizedExamplesProvider(runtime, first);
		registerLocalizedExamplesProvider(runtime, second);
		expect(getLocalizedExamplesProvider(runtime)).toBe(second);
	});

	it("reset is scoped to the given runtime", () => {
		const a = {} as never;
		const b = {} as never;
		registerLocalizedExamplesProvider(a, provider);
		registerLocalizedExamplesProvider(b, provider);
		__resetLocalizedExamplesProviderForTests(a);
		expect(getLocalizedExamplesProvider(a)).toBeNull();
		expect(getLocalizedExamplesProvider(b)).toBe(provider);
	});

	it("reset on a never-registered runtime is a safe no-op", () => {
		const runtime = {} as never;
		expect(() =>
			__resetLocalizedExamplesProviderForTests(runtime),
		).not.toThrow();
		expect(getLocalizedExamplesProvider(runtime)).toBeNull();
	});

	it("register after reset works again", () => {
		const runtime = {} as never;
		registerLocalizedExamplesProvider(runtime, provider);
		__resetLocalizedExamplesProviderForTests(runtime);
		const replacement = async () => null;
		registerLocalizedExamplesProvider(runtime, replacement);
		expect(getLocalizedExamplesProvider(runtime)).toBe(replacement);
	});
});

describe("localized-examples-provider async contract", () => {
	it("hands the exact registered function back and forwards the input to it", async () => {
		const runtime = {} as never;
		const observedInputs: Array<{ recentMessage?: string | null }> = [];
		registerLocalizedExamplesProvider(runtime, async (input) => {
			observedInputs.push(input);
			return ({ actionName, exampleIndex }) =>
				exampleIndex === 1 && actionName !== ""
					? [
							{
								name: actionName,
								content: { text: `localizado:${actionName}` },
							},
							{ name: actionName, content: { text: actionName } },
						]
					: null;
		});
		const retrieved = getLocalizedExamplesProvider(runtime);
		if (!retrieved) {
			throw new Error("expected the registered provider to be retrievable");
		}
		const resolver = await retrieved({ recentMessage: "bonjour" });
		expect(observedInputs).toEqual([{ recentMessage: "bonjour" }]);
		expect(typeof resolver).toBe("function");
		expect(resolver?.({ actionName: "HELP", exampleIndex: 1 })).toEqual([
			{ name: "HELP", content: { text: "localizado:HELP" } },
			{ name: "HELP", content: { text: "HELP" } },
		]);
		expect(resolver?.({ actionName: "HELP", exampleIndex: 0 })).toBeNull();
	});

	it("invocation arguments pass through verbatim, including absent and null recentMessage", async () => {
		const runtime = {} as never;
		const seen: unknown[] = [];
		registerLocalizedExamplesProvider(runtime, async (input) => {
			seen.push(input);
			return null;
		});
		const retrieved = getLocalizedExamplesProvider(runtime);
		if (!retrieved) {
			throw new Error("expected the registered provider to be retrievable");
		}
		const withNull = await retrieved({ recentMessage: null });
		const withNoArgument = await (retrieved as () => Promise<null>)();
		expect(withNull).toBeNull();
		expect(withNoArgument).toBeNull();
		expect(seen[0]).toEqual({ recentMessage: null });
		expect(seen[1]).toBeUndefined();
	});
});
