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
				computer: false,
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

	it("routes desktop computer status through the runtime broker", async () => {
		const calls: Array<{ method: string; params?: object }> = [];
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async (method, params) => {
				calls.push({ method, params });
				return {
					id: "eliza.computer",
					ok: true,
					platform: "darwin",
					capabilities: {},
					updatedAt: "2026-05-17T00:00:00.000Z",
				};
			},
		});

		await expect(router.computer.status()).resolves.toEqual({
			ok: true,
			platform: "darwin",
			raw: {
				id: "eliza.computer",
				ok: true,
				platform: "darwin",
				capabilities: {},
				updatedAt: "2026-05-17T00:00:00.000Z",
			},
		});
		expect(calls).toEqual([{ method: "computer.status", params: undefined }]);
	});

	it("routes desktop Git command execution through the runtime broker", async () => {
		const calls: Array<{ method: string; params?: object }> = [];
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async (method, params) => {
				calls.push({ method, params });
				return {
					operation: {
						id: "git-op-1",
						name: "git.command.run",
						cwd: "/repo",
						command: ["worktree", "list"],
						status: "completed",
						stdout: "/repo\n",
						stderr: "",
						exitCode: 0,
						signal: null,
						startedAt: "2026-05-17T00:00:00.000Z",
						completedAt: "2026-05-17T00:00:00.001Z",
					},
				};
			},
		});

		await expect(
			router.git.commandRun({
				root: "/repo",
				args: ["worktree", "list"],
			}),
		).resolves.toEqual({
			operation: {
				id: "git-op-1",
				name: "git.command.run",
				cwd: "/repo",
				command: ["worktree", "list"],
				status: "completed",
				stdout: "/repo\n",
				stderr: "",
				exitCode: 0,
				signal: null,
				startedAt: "2026-05-17T00:00:00.000Z",
				completedAt: "2026-05-17T00:00:00.001Z",
			},
		});
		expect(calls).toEqual([
			{
				method: "git.command.run",
				params: {
					cwd: "/repo",
					args: ["worktree", "list"],
				},
			},
		]);
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
