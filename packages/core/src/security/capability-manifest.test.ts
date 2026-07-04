/**
 * Per-call capability governance (issue #9235). An empty manifest is a no-op; a
 * cpuMs deadline is a real wall-clock bound that rejects an overrunning call;
 * the host/path allowlists are predicates the network/fs layers consult
 * (subdomain-aware host match, traversal-rejecting path match); and
 * withCapabilityGovernance wraps an action additively, preserving every field
 * but the handler.
 */

import { describe, expect, it, vi } from "vitest";
import type { Action } from "../types/components.ts";
import {
	applyCapabilityManifest,
	assertHostAllowed,
	CapabilityDeadlineError,
	CapabilityViolationError,
	frozenEnv,
	isHostAllowed,
	isPathAllowed,
	withCapabilityGovernance,
} from "./capability-manifest.ts";

describe("applyCapabilityManifest — deadline", () => {
	it("returns the value when the task finishes within budget (and with no budget)", async () => {
		await expect(
			applyCapabilityManifest(async () => 42, { cpuMs: 1000 }),
		).resolves.toBe(42);
		await expect(applyCapabilityManifest(async () => "ok", {})).resolves.toBe(
			"ok",
		);
	});

	it("rejects with CapabilityDeadlineError when the task overruns cpuMs", async () => {
		const slow = () =>
			new Promise<string>((resolve) => setTimeout(() => resolve("late"), 50));
		await expect(
			applyCapabilityManifest(slow, { cpuMs: 10 }),
		).rejects.toBeInstanceOf(CapabilityDeadlineError);
	});

	it("propagates the task's own rejection unchanged", async () => {
		const boom = async () => {
			throw new Error("inner failure");
		};
		await expect(
			applyCapabilityManifest(boom, { cpuMs: 1000 }),
		).rejects.toThrow("inner failure");
	});

	it("clears the deadline timer once the task settles (no dangling handle)", async () => {
		const clearSpy = vi.spyOn(globalThis, "clearTimeout");
		await applyCapabilityManifest(async () => 1, { cpuMs: 1000 });
		expect(clearSpy).toHaveBeenCalled();
		clearSpy.mockRestore();
	});
});

describe("isHostAllowed", () => {
	it("allows any host when no allowlist is set", () => {
		expect(isHostAllowed("anything.com", {})).toBe(true);
	});

	it("matches the apex and its subdomains, case-insensitively", () => {
		const m = { allowedHosts: ["example.com"] };
		expect(isHostAllowed("example.com", m)).toBe(true);
		expect(isHostAllowed("API.Example.com", m)).toBe(true);
		expect(isHostAllowed("evil.com", m)).toBe(false);
		// not a real subdomain — must not match by naive substring.
		expect(isHostAllowed("notexample.com", m)).toBe(false);
	});

	it("a leading-dot entry matches subdomains only, not the apex", () => {
		const m = { allowedHosts: [".example.com"] };
		expect(isHostAllowed("api.example.com", m)).toBe(true);
		expect(isHostAllowed("example.com", m)).toBe(false);
	});

	it("assertHostAllowed throws CapabilityViolationError on a miss", () => {
		expect(() =>
			assertHostAllowed("evil.com", { allowedHosts: ["x.com"] }),
		).toThrow(CapabilityViolationError);
	});
});

describe("isPathAllowed", () => {
	const m = { allowedPaths: ["/data/agents"] };

	it("allows any path when no allowlist is set", () => {
		expect(isPathAllowed("/etc/passwd", {})).toBe(true);
	});

	it("allows the root and paths under it, rejects siblings", () => {
		expect(isPathAllowed("/data/agents", m)).toBe(true);
		expect(isPathAllowed("/data/agents/x.json", m)).toBe(true);
		expect(isPathAllowed("/data/agents-other", m)).toBe(false); // prefix, not under root
		expect(isPathAllowed("/etc/passwd", m)).toBe(false);
	});

	it("always rejects a .. traversal segment", () => {
		expect(isPathAllowed("/data/agents/../../etc/passwd", m)).toBe(false);
	});
});

describe("frozenEnv", () => {
	it("returns a frozen copy of the manifest env", () => {
		const env = frozenEnv({ env: { API_KEY: "x" } });
		expect(env).toEqual({ API_KEY: "x" });
		expect(Object.isFrozen(env)).toBe(true);
		expect(frozenEnv({})).toEqual({});
	});
});

describe("withCapabilityGovernance", () => {
	const baseAction = {
		name: "DO_THING",
		description: "does a thing",
		similes: ["thing"],
		validate: async () => true,
		handler: async () => ({ success: true, text: "done" }),
	} as unknown as Action;

	it("preserves every field but re-binds the handler under the manifest", async () => {
		const governed = withCapabilityGovernance(baseAction, { cpuMs: 1000 });
		expect(governed.name).toBe("DO_THING");
		expect(governed.similes).toEqual(["thing"]);
		expect(governed.handler).not.toBe(baseAction.handler);
		await expect(
			governed.handler(
				{} as never,
				{} as never,
				undefined,
				undefined,
				undefined,
			),
		).resolves.toMatchObject({ success: true });
	});

	it("enforces the deadline on the wrapped handler", async () => {
		const slowAction = {
			...baseAction,
			handler: () =>
				new Promise((resolve) =>
					setTimeout(() => resolve({ success: true }), 50),
				),
		} as unknown as Action;
		const governed = withCapabilityGovernance(slowAction, { cpuMs: 10 });
		await expect(
			governed.handler(
				{} as never,
				{} as never,
				undefined,
				undefined,
				undefined,
			),
		).rejects.toBeInstanceOf(CapabilityDeadlineError);
	});
});
