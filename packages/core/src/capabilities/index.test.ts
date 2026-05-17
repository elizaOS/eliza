import { describe, expect, it } from "vitest";
import {
	CapabilityError,
	RuntimeBrokerCapabilityRouter,
	UnavailableCapabilityRouter,
} from "./index";

describe("capability router", () => {
	it("returns structured unavailable errors from fallback implementation", async () => {
		const router = new UnavailableCapabilityRouter("server");

		await expect(
			router.fs.readText({ path: "/tmp/file.txt" }),
		).rejects.toMatchObject({
			code: "CAPABILITY_UNAVAILABLE",
			capability: "fs",
			method: "fs.readText",
		});

		await expect(router.availability()).resolves.toMatchObject({
			environment: "server",
			available: false,
			capabilities: {
				fs: false,
				pty: false,
				git: false,
				model: false,
			},
		});
	});

	it("routes desktop file reads through the runtime broker", async () => {
		const calls: Array<{ method: string; params?: object }> = [];
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async (method, params) => {
				calls.push({ method, params });
				return {
					path: "/tmp/file.txt",
					text: "hello",
					size: 5,
					truncated: false,
				};
			},
		});

		await expect(
			router.fs.readText({ path: "/tmp/file.txt", maxBytes: 32 }),
		).resolves.toEqual({
			path: "/tmp/file.txt",
			text: "hello",
			size: 5,
			truncated: false,
		});
		expect(calls).toEqual([
			{
				method: "fs.readText",
				params: {
					path: "/tmp/file.txt",
					maxBytes: 32,
				},
			},
		]);
	});

	it("wraps broker failures as capability request failures", async () => {
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async () => {
				throw new Error("broker offline");
			},
		});

		await expect(router.model.status()).rejects.toMatchObject({
			code: "CAPABILITY_REQUEST_FAILED",
			capability: "model",
			method: "model.status",
			message: "broker offline",
		});
	});

	it("preserves capability errors from the broker", async () => {
		const expected = new CapabilityError({
			code: "CAPABILITY_UNAVAILABLE",
			message: "not available",
			capability: "git",
			method: "git.status",
		});
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async () => {
				throw expected;
			},
		});

		await expect(router.git.status({ root: "/repo" })).rejects.toBe(expected);
	});
});
