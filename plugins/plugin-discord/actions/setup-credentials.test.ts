/**
 * Unit tests for connector `/setup` credential presets: honest GitHub probe
 * success and hung-probe fail-closed. Deterministic fetch mocks; no live APIs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPreset } from "./setup-credentials";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("setup-credentials presets", () => {
	it("vends a verified GitHub identity from a successful user probe", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({ login: "octocat" }, { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const preset = getPreset("github");
		expect(preset).toBeDefined();
		await expect(preset?.validate({ token: "ghp_test" })).resolves.toEqual({
			valid: true,
			identity: "@octocat",
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.github.com/user",
			expect.objectContaining({
				signal: expect.any(AbortSignal),
			}),
		);
	});

	it("fails closed on a hung GitHub credential probe instead of waiting forever", async () => {
		vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
			const controller = new AbortController();
			setTimeout(() => {
				controller.abort(
					Object.assign(new Error("The operation was aborted due to timeout"), {
						name: "TimeoutError",
					}),
				);
			}, 50);
			return controller.signal;
		});
		const fetchMock = vi.fn(
			(_url: string, init?: { signal?: AbortSignal }) =>
				new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					if (!signal) return;
					if (signal.aborted) {
						reject(signal.reason);
						return;
					}
					signal.addEventListener("abort", () => reject(signal.reason));
				}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const preset = getPreset("github");
		const started = Date.now();
		await expect(preset?.validate({ token: "ghp_test" })).resolves.toEqual({
			valid: false,
			error: "The operation was aborted due to timeout",
		});
		expect(Date.now() - started).toBeLessThan(1_000);
	});
});
