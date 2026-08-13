/**
 * Deterministic unit coverage for {@link StackContextManager}. The class is a
 * synchronous stack with no clock or I/O, so every case is an exact assertion.
 *
 * The load-bearing property is that `run` pops in a `finally`: the manager is
 * the fallback for environments without AsyncLocalStorage, and a frame left on
 * the stack by a throwing callback would silently mis-attribute the context of
 * every later `active()` call rather than fail at the throw site. The suite
 * therefore proves unwinding on the exception path, not just the happy one.
 *
 * The documented limitation — context is not preserved across an await — is
 * asserted too, so nobody reads the absence of a case as a guarantee.
 */

import { describe, expect, it } from "vitest";
import { StackContextManager } from "./stack-context-manager";

describe("StackContextManager", () => {
	it("has no active context before anything runs", () => {
		expect(new StackContextManager<string>().active()).toBeUndefined();
	});

	it("exposes the context for the duration of the callback and returns its value", () => {
		const manager = new StackContextManager<string>();
		const returned = manager.run("outer", () => {
			expect(manager.active()).toBe("outer");
			return 42;
		});
		expect(returned).toBe(42);
	});

	it("restores the previous context after the callback completes", () => {
		const manager = new StackContextManager<string>();
		manager.run("outer", () => {});
		expect(manager.active()).toBeUndefined();
	});

	it("resolves nested contexts innermost-first and unwinds in order", () => {
		const manager = new StackContextManager<string>();
		const seen: (string | undefined)[] = [];
		manager.run("a", () => {
			seen.push(manager.active());
			manager.run("b", () => {
				seen.push(manager.active());
				manager.run("c", () => seen.push(manager.active()));
				seen.push(manager.active());
			});
			seen.push(manager.active());
		});
		seen.push(manager.active());
		expect(seen).toEqual(["a", "b", "c", "b", "a", undefined]);
	});

	it("pops the frame when the callback throws", () => {
		// The invariant that matters: a leaked frame would not fail here, it would
		// silently mis-attribute every later active() call.
		const manager = new StackContextManager<string>();
		expect(() =>
			manager.run("doomed", () => {
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(manager.active()).toBeUndefined();
	});

	it("pops only the throwing frame, leaving the outer context intact", () => {
		const manager = new StackContextManager<string>();
		manager.run("outer", () => {
			expect(() =>
				manager.run("inner", () => {
					throw new Error("inner failed");
				}),
			).toThrow("inner failed");
			expect(manager.active()).toBe("outer");
		});
		expect(manager.active()).toBeUndefined();
	});

	it("rethrows the original error unchanged", () => {
		const manager = new StackContextManager<string>();
		const error = new Error("original");
		expect(() =>
			manager.run("ctx", () => {
				throw error;
			}),
		).toThrow(error);
	});

	it("keeps distinct instances isolated", () => {
		const first = new StackContextManager<string>();
		const second = new StackContextManager<string>();
		first.run("first-only", () => {
			expect(first.active()).toBe("first-only");
			expect(second.active()).toBeUndefined();
		});
	});

	it("carries any context value, including falsy and object ones", () => {
		const numbers = new StackContextManager<number>();
		numbers.run(0, () => expect(numbers.active()).toBe(0));

		const shape = { requestId: "r-1" };
		const objects = new StackContextManager<typeof shape>();
		objects.run(shape, () => expect(objects.active()).toBe(shape));
	});

	it("does not preserve context across an await, as documented", () => {
		// run() is synchronous: it pops as soon as the callback returns, so an
		// async callback's continuation observes no context. Asserted so the
		// documented limitation is not mistaken for an untested gap.
		const manager = new StackContextManager<string>();
		const settled = manager.run("ctx", async () => {
			await Promise.resolve();
			return manager.active();
		});
		expect(manager.active()).toBeUndefined();
		return expect(settled).resolves.toBeUndefined();
	});
});
