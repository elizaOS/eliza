/**
 * Real-runtime regression for AgentRuntime.useModel cancellation: the provider
 * transport must observe both the caller signal and the turn signal. Uses a
 * real AgentRuntime with SQLite storage and a real local HTTP response body;
 * no live model calls.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { describe, expect, it, vi } from "vitest";
import { runWithStreamingContext } from "../../streaming-context";
import type { Character } from "../../types/agent.js";
import { ModelType } from "../../types/model.js";

function makeRuntime() {
	return createSQLiteTestRuntime({
		character: {
			name: "CancellationAgent",
			bio: "test",
			settings: {},
		} as Character,
		logLevel: "fatal",
	});
}

interface HangingEndpoint {
	url: string;
	close: () => Promise<void>;
	requestReceived: Promise<void>;
}

function startHangingEndpoint(): Promise<HangingEndpoint> {
	return new Promise((resolve, reject) => {
		let notifyRequest!: () => void;
		const requestReceived = new Promise<void>((done) => {
			notifyRequest = done;
		});
		const server = createServer((req, res) => {
			notifyRequest();
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.write("partial-");
			req.on("close", () => {
				try {
					res.end();
				} catch {
					// Client already gone; nothing to report.
				}
			});
		});
		const sockets = new Set<import("node:net").Socket>();
		server.on("connection", (socket) => {
			sockets.add(socket);
			socket.on("close", () => sockets.delete(socket));
		});
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address() as AddressInfo | null;
			if (!address) {
				reject(new Error("hanging endpoint has no address"));
				return;
			}
			resolve({
				url: `http://127.0.0.1:${address.port}/hang`,
				requestReceived,
				close: () =>
					new Promise<void>((done) => {
						for (const socket of sockets) socket.destroy();
						server.close(() => done());
					}),
			});
		});
	});
}

function timeoutError(message: string, ms: number): Promise<never> {
	return new Promise<never>((_, reject) => {
		setTimeout(() => reject(new Error(message)), ms);
	});
}

describe("AgentRuntime.useModel cancellation", () => {
	it("cancels the provider transport when the turn aborts and an explicit signal is present", async () => {
		const endpoint = await startHangingEndpoint();
		try {
			const runtime = makeRuntime();
			let observedSignal: AbortSignal | undefined;
			const primary = vi.fn(
				async (_rt: unknown, params: Record<string, unknown>) => {
					observedSignal = (params as { signal?: AbortSignal }).signal;
					const response = await fetch(endpoint.url, {
						signal: observedSignal,
					});
					return response.text();
				},
			);
			const backup = vi.fn(async () => "backup must not run on cancel");
			runtime.registerModel(ModelType.TEXT_LARGE, primary, "primary", 100);
			runtime.registerModel(ModelType.TEXT_LARGE, backup, "backup", 10);

			const caller = new AbortController();
			const turn = new AbortController();
			const callerParams = { prompt: "hello", signal: caller.signal };
			const useModelPromise = runWithStreamingContext(
				{ messageId: "cancel-turn-with-explicit", abortSignal: turn.signal },
				() => runtime.useModel(ModelType.TEXT_LARGE, callerParams),
			);
			await endpoint.requestReceived;
			expect(observedSignal).toBeDefined();
			turn.abort();
			await expect(
				Promise.race([
					useModelPromise,
					timeoutError("turn abort did not cancel transport", 2000),
				]),
			).rejects.toSatisfy(
				(error: unknown) =>
					error instanceof Error && error.name === "AbortError",
			);
			expect(caller.signal.aborted).toBe(false);
			expect(backup).not.toHaveBeenCalled();
			expect(callerParams.signal).toBe(caller.signal);
		} finally {
			await endpoint.close();
		}
	});

	it("cancels when the caller aborts and an explicit signal is present", async () => {
		const endpoint = await startHangingEndpoint();
		try {
			const runtime = makeRuntime();
			const primary = vi.fn(
				async (_rt: unknown, params: Record<string, unknown>) => {
					const signal = (params as { signal?: AbortSignal }).signal;
					const response = await fetch(endpoint.url, { signal });
					return response.text();
				},
			);
			runtime.registerModel(ModelType.TEXT_LARGE, primary, "primary", 100);
			const caller = new AbortController();
			const turn = new AbortController();
			const useModelPromise = runWithStreamingContext(
				{ messageId: "cancel-caller-with-explicit", abortSignal: turn.signal },
				() =>
					runtime.useModel(ModelType.TEXT_LARGE, {
						prompt: "hello",
						signal: caller.signal,
					}),
			);
			await endpoint.requestReceived;
			caller.abort();
			await expect(
				Promise.race([
					useModelPromise,
					timeoutError("caller abort did not cancel transport", 2000),
				]),
			).rejects.toSatisfy(
				(error: unknown) =>
					error instanceof Error && error.name === "AbortError",
			);
			expect(turn.signal.aborted).toBe(false);
		} finally {
			await endpoint.close();
		}
	});

	it("cancels when the turn aborts without an explicit signal", async () => {
		const endpoint = await startHangingEndpoint();
		try {
			const runtime = makeRuntime();
			let observedSignal: AbortSignal | undefined;
			const primary = vi.fn(
				async (_rt: unknown, params: Record<string, unknown>) => {
					observedSignal = (params as { signal?: AbortSignal }).signal;
					const response = await fetch(endpoint.url, {
						signal: observedSignal,
					});
					return response.text();
				},
			);
			runtime.registerModel(ModelType.TEXT_LARGE, primary, "primary", 100);
			const turn = new AbortController();
			const useModelPromise = runWithStreamingContext(
				{ messageId: "cancel-turn-only", abortSignal: turn.signal },
				() => runtime.useModel(ModelType.TEXT_LARGE, { prompt: "hello" }),
			);
			await endpoint.requestReceived;
			expect(observedSignal).toBe(turn.signal);
			turn.abort();
			await expect(
				Promise.race([
					useModelPromise,
					timeoutError("turn abort did not cancel transport", 2000),
				]),
			).rejects.toSatisfy(
				(error: unknown) =>
					error instanceof Error && error.name === "AbortError",
			);
		} finally {
			await endpoint.close();
		}
	});

	it("preserves signal identity when explicit and turn share the same signal", async () => {
		const runtime = makeRuntime();
		let observedSignal: AbortSignal | undefined;
		runtime.registerModel(
			ModelType.TEXT_LARGE,
			vi.fn(async (_rt: unknown, params: Record<string, unknown>) => {
				observedSignal = (params as { signal?: AbortSignal }).signal;
				return "shared ok";
			}),
			"primary",
			100,
		);
		const shared = new AbortController();
		const result = await runWithStreamingContext(
			{ messageId: "cancel-shared", abortSignal: shared.signal },
			() =>
				runtime.useModel(ModelType.TEXT_LARGE, {
					prompt: "hello",
					signal: shared.signal,
				}),
		);
		expect(result).toBe("shared ok");
		expect(observedSignal).toBe(shared.signal);
	});

	it("rejects before dispatch when the explicit signal is already aborted", async () => {
		const runtime = makeRuntime();
		const primary = vi.fn(async () => "must not run");
		runtime.registerModel(ModelType.TEXT_LARGE, primary, "primary", 100);
		const caller = new AbortController();
		caller.abort();
		await expect(
			runtime.useModel(ModelType.TEXT_LARGE, {
				prompt: "hello",
				signal: caller.signal,
			}),
		).rejects.toSatisfy(
			(error: unknown) => error instanceof Error && error.name === "AbortError",
		);
		expect(primary).not.toHaveBeenCalled();
	});

	it("rejects before dispatch when the turn signal is already aborted", async () => {
		const runtime = makeRuntime();
		const primary = vi.fn(async () => "must not run");
		runtime.registerModel(ModelType.TEXT_LARGE, primary, "primary", 100);
		const turn = new AbortController();
		turn.abort();
		await expect(
			runWithStreamingContext(
				{ messageId: "cancel-preaborted-turn", abortSignal: turn.signal },
				() => runtime.useModel(ModelType.TEXT_LARGE, { prompt: "hello" }),
			),
		).rejects.toSatisfy(
			(error: unknown) => error instanceof Error && error.name === "AbortError",
		);
		expect(primary).not.toHaveBeenCalled();
	});

	it("succeeds when neither signal aborts and leaves both controllers unaborted", async () => {
		const runtime = makeRuntime();
		const primary = vi.fn(async () => "live result");
		const backup = vi.fn(async () => "backup must not run");
		runtime.registerModel(ModelType.TEXT_LARGE, primary, "primary", 100);
		runtime.registerModel(ModelType.TEXT_LARGE, backup, "backup", 10);
		const caller = new AbortController();
		const turn = new AbortController();
		const callerParams = { prompt: "hello", signal: caller.signal };
		const result = await runWithStreamingContext(
			{ messageId: "cancel-success", abortSignal: turn.signal },
			() => runtime.useModel(ModelType.TEXT_LARGE, callerParams),
		);
		expect(result).toBe("live result");
		expect(primary).toHaveBeenCalledTimes(1);
		expect(backup).not.toHaveBeenCalled();
		expect(caller.signal.aborted).toBe(false);
		expect(turn.signal.aborted).toBe(false);
		expect(callerParams.signal).toBe(caller.signal);
	});
});
