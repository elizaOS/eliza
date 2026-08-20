/**
 * Overflow coverage for Agent Skills package downloads. The deterministic
 * stream and loopback harnesses prove exact-cap acceptance, missing-body and
 * stalled-body failure, cancellation and lock release, UTF-8 decoding, and
 * fail-closed behavior through every remote installer.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemorySkillStore } from "../storage";
import {
	createSkillDownloadLifecycle,
	DEFAULT_SKILL_DOWNLOAD_TIMEOUT_MS,
	MAX_SKILL_DOWNLOAD_TIMEOUT_MS,
	MAX_SKILL_PACKAGE_BYTES,
	readCappedSkillPackage,
	readCappedSkillText,
} from "./skill-package-bytes";
import { AgentSkillsService } from "./skills";

function streamOf(
	bytes: Uint8Array,
	chunkSize = 64 * 1024,
): Response {
	let offset = 0;
	return new Response(
		new ReadableStream<Uint8Array>({
			pull(controller) {
				if (offset >= bytes.byteLength) {
					controller.close();
					return;
				}
				const end = Math.min(offset + chunkSize, bytes.byteLength);
				controller.enqueue(bytes.subarray(offset, end));
				offset = end;
			},
		}),
	);
}

function openOverflowStream(
	onCancel: () => void | Promise<void>,
): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(MAX_SKILL_PACKAGE_BYTES + 1));
			},
			cancel() {
				onCancel();
			},
		}),
	);
}

function stalledResponse(
	content: string | Uint8Array = "partial",
	onCancel: () => void | Promise<void> = () => {},
): Response {
	const bytes =
		typeof content === "string" ? new TextEncoder().encode(content) : content;
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes);
			},
			cancel() {
				onCancel();
			},
		}),
		{ headers: { "content-type": "text/markdown" } },
	);
}

function unusedErrorResponse(
	status: number,
	onCancel: () => void | Promise<void>,
): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("partial error"));
			},
			cancel() {
				return onCancel();
			},
		}),
		{ status },
	);
}

function createRuntime(): IAgentRuntime {
	return {
		getSetting: vi.fn(() => undefined),
		logger: {
			debug: vi.fn(),
			error: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
		},
	} as unknown as IAgentRuntime;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("readCappedSkillPackage", () => {
	it("accepts a package at the 10MB cap", async () => {
		const body = new Uint8Array(MAX_SKILL_PACKAGE_BYTES);
		body[0] = 80;
		body[1] = 75;
		const got = await readCappedSkillPackage(streamOf(body));
		expect(got.byteLength).toBe(MAX_SKILL_PACKAGE_BYTES);
		expect(got[0]).toBe(80);
		expect(got[1]).toBe(75);
	});

	it("rejects one byte past the cap without retaining the overflow", async () => {
		const cancel = vi.fn();
		const response = openOverflowStream(cancel);

		await expect(readCappedSkillPackage(response)).rejects.toMatchObject({
			message: "Package too large (max 10MB)",
			code: "SKILL_PACKAGE_TOO_LARGE",
			context: {
				maxBytes: MAX_SKILL_PACKAGE_BYTES,
				receivedBytes: MAX_SKILL_PACKAGE_BYTES + 1,
			},
		});
		expect(cancel).toHaveBeenCalledOnce();
		expect(response.body?.locked).toBe(false);
	});

	it("does not let cancellation failure mask the typed size error", async () => {
		const cancel = vi.fn(async () => {
			throw new Error("transport cancel failed");
		});

		await expect(
			readCappedSkillPackage(openOverflowStream(cancel)),
		).rejects.toMatchObject({ code: "SKILL_PACKAGE_TOO_LARGE" });
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("rejects a response without a body as a typed boundary failure", async () => {
		await expect(
			readCappedSkillPackage(new Response(null)),
		).rejects.toMatchObject({
			code: "SKILL_DOWNLOAD_MISSING_BODY",
			context: { boundary: "skill-package-download" },
		});
	});

	it("applies the default deadline and supports explicit override or opt-out", () => {
		const defaultLifecycle = createSkillDownloadLifecycle();
		expect(defaultLifecycle.timeoutMs).toBe(DEFAULT_SKILL_DOWNLOAD_TIMEOUT_MS);
		defaultLifecycle.dispose();

		const overridden = createSkillDownloadLifecycle({ downloadTimeoutMs: 123 });
		expect(overridden.timeoutMs).toBe(123);
		overridden.dispose();

		const fractional = createSkillDownloadLifecycle({ downloadTimeoutMs: 0.5 });
		expect(fractional.timeoutMs).toBe(0.5);
		fractional.dispose();

		const optedOut = createSkillDownloadLifecycle({ downloadTimeoutMs: null });
		expect(optedOut.timeoutMs).toBeNull();
		expect(optedOut.signal.aborted).toBe(false);
		optedOut.dispose();
	});

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects invalid deadline override %s",
		(downloadTimeoutMs) => {
		expect(() =>
			createSkillDownloadLifecycle({ downloadTimeoutMs }),
		).toThrow(
			expect.objectContaining({ code: "SKILL_DOWNLOAD_INVALID_TIMEOUT" }),
		);
		},
	);

	it("segments deadlines above the native timer limit without expiring early", () => {
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const lifecycle = createSkillDownloadLifecycle({
			downloadTimeoutMs: Number.MAX_VALUE,
		});

		expect(setTimeoutSpy).toHaveBeenCalledWith(
			expect.any(Function),
			MAX_SKILL_DOWNLOAD_TIMEOUT_MS,
		);
		expect(lifecycle.signal.aborted).toBe(false);

		lifecycle.dispose();
		setTimeoutSpy.mockRestore();
	});

	it("keeps the first abort reason and disarms caller and timer hooks", async () => {
		vi.useFakeTimers();
		const callerFirst = new AbortController();
		const callerFirstLifecycle = createSkillDownloadLifecycle({
			signal: callerFirst.signal,
			downloadTimeoutMs: 20,
		});
		callerFirst.abort(new Error("caller won"));
		await vi.advanceTimersByTimeAsync(20);
		expect(callerFirstLifecycle.signal.reason).toMatchObject({
			code: "SKILL_DOWNLOAD_ABORTED",
		});
		callerFirstLifecycle.dispose();

		const deadlineFirst = new AbortController();
		const deadlineFirstLifecycle = createSkillDownloadLifecycle({
			signal: deadlineFirst.signal,
			downloadTimeoutMs: 20,
		});
		await vi.advanceTimersByTimeAsync(20);
		deadlineFirst.abort(new Error("caller lost"));
		expect(deadlineFirstLifecycle.signal.reason).toMatchObject({
			code: "SKILL_DOWNLOAD_TIMEOUT",
		});
		deadlineFirstLifecycle.dispose();

		const disposedCaller = new AbortController();
		const disposedLifecycle = createSkillDownloadLifecycle({
			signal: disposedCaller.signal,
			downloadTimeoutMs: 20,
		});
		disposedLifecycle.dispose();
		disposedCaller.abort(new Error("late caller"));
		await vi.advanceTimersByTimeAsync(25);
		expect(disposedLifecycle.signal.aborted).toBe(false);
	});

	it("cancels a stalled body with the typed deadline error", async () => {
		const cancel = vi.fn();
		const response = stalledResponse("partial", cancel);
		const lifecycle = createSkillDownloadLifecycle({ downloadTimeoutMs: 25 });

		try {
			await expect(
				readCappedSkillPackage(response, { signal: lifecycle.signal }),
			).rejects.toMatchObject({
				code: "SKILL_DOWNLOAD_TIMEOUT",
				context: { timeoutMs: 25 },
			});
			expect(cancel).toHaveBeenCalledOnce();
			expect(response.body?.locked).toBe(false);
		} finally {
			lifecycle.dispose();
		}
	});

	it("preserves caller cancellation as the authoritative error", async () => {
		const caller = new AbortController();
		const cancel = vi.fn(async () => {
			throw new Error("transport cancel failed");
		});
		const response = stalledResponse("partial", cancel);
		const lifecycle = createSkillDownloadLifecycle({
			signal: caller.signal,
			downloadTimeoutMs: 1_000,
		});
		const read = readCappedSkillPackage(response, {
			signal: lifecycle.signal,
		});
		caller.abort(new Error("caller stopped waiting"));

		try {
			await expect(read).rejects.toMatchObject({
				code: "SKILL_DOWNLOAD_ABORTED",
				cause: expect.objectContaining({ message: "caller stopped waiting" }),
			});
			expect(cancel).toHaveBeenCalledOnce();
		} finally {
			lifecycle.dispose();
		}
	});

	it("lets caller cancellation win when the body closes in the same turn", async () => {
		const caller = new AbortController();
		let pullCount = 0;
		const response = new Response(
			new ReadableStream<Uint8Array>({
				pull(controller) {
					if (pullCount++ === 0) {
						controller.enqueue(new TextEncoder().encode("complete"));
						return;
					}
					controller.close();
					caller.abort(new Error("caller stopped at completion"));
				},
			}),
		);
		const lifecycle = createSkillDownloadLifecycle({
			signal: caller.signal,
			downloadTimeoutMs: null,
		});

		try {
			await expect(
				readCappedSkillPackage(response, { signal: lifecycle.signal }),
			).rejects.toMatchObject({
				code: "SKILL_DOWNLOAD_ABORTED",
				cause: expect.objectContaining({
					message: "caller stopped at completion",
				}),
			});
			expect(response.body?.locked).toBe(false);
		} finally {
			lifecycle.dispose();
		}
	});

	it("cancels an unread body when its signal is already aborted", async () => {
		const caller = new AbortController();
		const cancel = vi.fn();
		const response = stalledResponse("unread", cancel);
		caller.abort(new Error("caller stopped before consumption"));

		await expect(
			readCappedSkillPackage(response, { signal: caller.signal }),
		).rejects.toMatchObject({
			code: "SKILL_DOWNLOAD_ABORTED",
			cause: expect.objectContaining({
				message: "caller stopped before consumption",
			}),
		});
		expect(cancel).toHaveBeenCalledOnce();
		expect(response.body?.locked).toBe(false);
	});

	it("propagates caller cancellation through the direct-URL installer", async () => {
		let installSignal: AbortSignal | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: unknown, init?: RequestInit) => {
				installSignal = init?.signal;
				return stalledResponse("partial");
			}),
		);
		const caller = new AbortController();
		const storage = new MemorySkillStore();
		const service = await AgentSkillsService.start(createRuntime(), {
			autoLoad: false,
			storage,
		});
		const install = service.installFromUrl(
			"https://skills.example/cancelled.md",
			{
				signal: caller.signal,
				downloadTimeoutMs: null,
				throwOnDownloadError: true,
			},
		);
		caller.abort(new Error("request owner stopped waiting"));

		await expect(install).rejects.toMatchObject({
			code: "SKILL_DOWNLOAD_ABORTED",
			cause: expect.objectContaining({
				message: "request owner stopped waiting",
			}),
		});
		expect(installSignal?.aborted).toBe(true);
		expect(storage.getPackage("cancelled")).toBeUndefined();
	});

	it("rejects a pre-aborted caller before fetch or persistence", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const storage = new MemorySkillStore();
		const service = await AgentSkillsService.start(createRuntime(), {
			autoLoad: false,
			storage,
		});
		const caller = new AbortController();
		caller.abort(new Error("already disconnected"));

		await expect(
			service.installFromUrl("https://skills.example/pre-aborted.md", {
				signal: caller.signal,
				slug: "pre-aborted",
				throwOnDownloadError: true,
			}),
		).rejects.toMatchObject({ code: "SKILL_DOWNLOAD_ABORTED" });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(storage.getPackage("pre-aborted")).toBeUndefined();
	});

	it("inherits one service deadline while preserving override and opt-out", async () => {
		const fetchMock = vi.fn(async () => new Response("missing", { status: 404 }));
		vi.stubGlobal("fetch", fetchMock);
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const perRequestTimeoutSpy = vi.spyOn(AbortSignal, "timeout");
		const service = await AgentSkillsService.start(createRuntime(), {
			autoLoad: false,
			fetchTimeoutMs: 1_234,
			storage: new MemorySkillStore(),
		});

		await expect(
			service.installFromUrl("https://skills.example/inherited.md"),
		).resolves.toBe(false);
		expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1_234);
		expect(perRequestTimeoutSpy).not.toHaveBeenCalled();

		setTimeoutSpy.mockClear();
		await expect(
			service.installFromUrl("https://skills.example/override.md", {
				downloadTimeoutMs: 567,
			}),
		).resolves.toBe(false);
		expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 567);

		setTimeoutSpy.mockClear();
		await expect(
			service.installFromUrl("https://skills.example/opt-out.md", {
				downloadTimeoutMs: null,
			}),
		).resolves.toBe(false);
		expect(setTimeoutSpy).not.toHaveBeenCalled();
	});

	it("keeps caller cancellation boolean-compatible unless typed errors are requested", async () => {
		const cancel = vi.fn();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => stalledResponse("partial", cancel)),
		);
		const caller = new AbortController();
		const storage = new MemorySkillStore();
		const service = await AgentSkillsService.start(createRuntime(), {
			autoLoad: false,
			storage,
		});
		const install = service.installFromUrl(
			"https://skills.example/boolean-cancelled.md",
			{
				signal: caller.signal,
				downloadTimeoutMs: null,
			},
		);
		caller.abort(new Error("legacy caller stopped waiting"));

		await expect(install).resolves.toBe(false);
		expect(cancel).toHaveBeenCalledOnce();
		expect(storage.getPackage("boolean-cancelled")).toBeUndefined();
	});

	it("decodes a capped SKILL.md body as UTF-8", async () => {
		const text = await readCappedSkillText(
			new Response("name: demo\n", { headers: { "content-type": "text/markdown" } }),
		);
		expect(text).toBe("name: demo\n");
	});

	it("rejects malformed UTF-8 instead of changing skill instructions", async () => {
		await expect(
			readCappedSkillText(new Response(new Uint8Array([0xc3, 0x28]))),
		).rejects.toMatchObject({
			code: "SKILL_PACKAGE_INVALID_UTF8",
			context: { byteLength: 2 },
			cause: expect.any(TypeError),
		});
	});

	it("fails a real direct-URL install and cancels before saving an oversized body", async () => {
		const cancel = vi.fn();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => openOverflowStream(cancel)),
		);
		const storage = new MemorySkillStore();
		const service = await AgentSkillsService.start(createRuntime(), {
			autoLoad: false,
			storage,
		});

		await expect(
			service.installFromUrl("https://skills.example/oversized.md", {
				slug: "oversized",
			}),
		).resolves.toBe(false);
		expect(cancel).toHaveBeenCalledOnce();
		expect(storage.getPackage("oversized")).toBeUndefined();
	});

	it("fails a real direct-URL install without persisting a missing body", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(null)));
		const storage = new MemorySkillStore();
		const service = await AgentSkillsService.start(createRuntime(), {
			autoLoad: false,
			storage,
		});

		await expect(
			service.installFromUrl("https://skills.example/missing.md", {
				slug: "missing",
				throwOnDownloadError: true,
			}),
		).rejects.toMatchObject({
			code: "SKILL_DOWNLOAD_MISSING_BODY",
			context: { boundary: "skill-package-download" },
		});
		expect(storage.getPackage("missing")).toBeUndefined();
	});

	it("cancels an unused non-success body without masking boolean compatibility", async () => {
		const cancel = vi.fn(async () => {
			throw new Error("discard failed");
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(new TextEncoder().encode("partial error"));
							},
							cancel,
						}),
						{ status: 502 },
					),
			),
		);
		const storage = new MemorySkillStore();
		const service = await AgentSkillsService.start(createRuntime(), {
			autoLoad: false,
			storage,
		});

		await expect(
			service.installFromUrl("https://skills.example/unavailable.md", {
				throwOnDownloadError: true,
			}),
		).resolves.toBe(false);
		expect(cancel).toHaveBeenCalledOnce();
		expect(storage.getPackage("unavailable")).toBeUndefined();
	});

	it.each([200, 502])(
		"lets caller cancellation win when fetch settles with status %s",
		async (status) => {
			const caller = new AbortController();
			const cancel = vi.fn();
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => {
					const response = unusedErrorResponse(status, cancel);
					caller.abort(new Error("caller stopped as headers settled"));
					return response;
				}),
			);
			const storage = new MemorySkillStore();
			const service = await AgentSkillsService.start(createRuntime(), {
				autoLoad: false,
				storage,
			});

			await expect(
				service.installFromUrl("https://skills.example/settled.md", {
					signal: caller.signal,
					downloadTimeoutMs: null,
					throwOnDownloadError: true,
				}),
			).rejects.toMatchObject({
				code: "SKILL_DOWNLOAD_ABORTED",
				cause: expect.objectContaining({
					message: "caller stopped as headers settled",
				}),
			});
			expect(cancel).toHaveBeenCalledOnce();
			expect(storage.getPackage("settled")).toBeUndefined();
		},
	);

	it("preserves catalog cancellation over a same-turn non-success status", async () => {
		const caller = new AbortController();
		const cancel = vi.fn();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				const response = unusedErrorResponse(502, cancel);
				caller.abort(new Error("catalog owner stopped as headers settled"));
				return response;
			}),
		);
		const storage = new MemorySkillStore();
		const service = await AgentSkillsService.start(createRuntime(), {
			autoLoad: false,
			storage,
		});

		await expect(
			service.install("catalog-cancelled", {
				signal: caller.signal,
				downloadTimeoutMs: null,
				throwOnDownloadError: true,
			}),
		).rejects.toMatchObject({
			code: "SKILL_DOWNLOAD_ABORTED",
			cause: expect.objectContaining({
				message: "catalog owner stopped as headers settled",
			}),
		});
		expect(cancel).toHaveBeenCalledOnce();
		expect(storage.getPackage("catalog-cancelled")).toBeUndefined();
	});

	it("preserves catalog cancellation when 404 body teardown aborts the caller", async () => {
		const caller = new AbortController();
		const cancel = vi.fn(() => {
			caller.abort(new Error("owner stopped during 404 teardown"));
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => unusedErrorResponse(404, cancel)),
		);
		const storage = new MemorySkillStore();
		const service = await AgentSkillsService.start(createRuntime(), {
			autoLoad: false,
			storage,
		});

		await expect(
			service.install("catalog-404-cancelled", {
				signal: caller.signal,
				downloadTimeoutMs: null,
				throwOnDownloadError: true,
			}),
		).rejects.toMatchObject({
			code: "SKILL_DOWNLOAD_ABORTED",
			cause: expect.objectContaining({
				message: "owner stopped during 404 teardown",
			}),
		});
		expect(cancel).toHaveBeenCalledOnce();
		expect(storage.getPackage("catalog-404-cancelled")).toBeUndefined();
	});

	it("does not cache catalog details that complete with caller cancellation", async () => {
		const caller = new AbortController();
		let requestCount = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				requestCount += 1;
				if (requestCount === 1) {
					return new Response(
						new ReadableStream<Uint8Array>({
							pull(controller) {
								controller.enqueue(
									new TextEncoder().encode(
										'{"latestVersion":{"version":"1.0.0"}}',
									),
								);
								controller.close();
								caller.abort(new Error("catalog owner stopped at completion"));
							},
						}),
						{ headers: { "content-type": "application/json" } },
					);
				}
				return new Response(
					JSON.stringify({ latestVersion: { version: "2.0.0" } }),
					{ headers: { "content-type": "application/json" } },
				);
			}),
		);
		const storage = new MemorySkillStore();
		const service = await AgentSkillsService.start(createRuntime(), {
			autoLoad: false,
			storage,
		});

		await expect(
			service.install("catalog-completion-cancelled", {
				signal: caller.signal,
				downloadTimeoutMs: null,
				throwOnDownloadError: true,
			}),
		).rejects.toMatchObject({
			code: "SKILL_DOWNLOAD_ABORTED",
			cause: expect.objectContaining({
				message: "catalog owner stopped at completion",
			}),
		});

		await expect(
			service.getSkillDetails("catalog-completion-cancelled"),
		).resolves.toMatchObject({ latestVersion: { version: "2.0.0" } });
		expect(requestCount).toBe(2);
		expect(storage.getPackage("catalog-completion-cancelled")).toBeUndefined();
	});

	it("does not persist GitHub SKILL.md when cancellation settles with a missing README", async () => {
		const caller = new AbortController();
		const cancel = vi.fn();
		const fetchMock = vi.fn(async () => {
			if (fetchMock.mock.calls.length === 1) {
				return new Response(
					"---\nname: github-readme-cancelled\ndescription: test\n---\n# Test\n",
				);
			}
			const response = unusedErrorResponse(404, cancel);
			caller.abort(new Error("caller stopped as README settled"));
			return response;
		});
		vi.stubGlobal("fetch", fetchMock);
		const storage = new MemorySkillStore();
		const service = await AgentSkillsService.start(createRuntime(), {
			autoLoad: false,
			storage,
		});

		await expect(
			service.installFromGitHub("owner/github-readme-cancelled", {
				signal: caller.signal,
				downloadTimeoutMs: null,
				throwOnDownloadError: true,
			}),
		).rejects.toMatchObject({
			code: "SKILL_DOWNLOAD_ABORTED",
			cause: expect.objectContaining({
				message: "caller stopped as README settled",
			}),
		});
		expect(cancel).toHaveBeenCalledOnce();
		expect(storage.getPackage("github-readme-cancelled")).toBeUndefined();
	});

	it("uses one deadline for catalog resolution and a stalled package body", async () => {
		const signals: AbortSignal[] = [];
		const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
			if (init?.signal) signals.push(init.signal);
			if (fetchMock.mock.calls.length === 1) {
				return new Response(
					JSON.stringify({ latestVersion: { version: "1.0.0" } }),
					{ headers: { "content-type": "application/json" } },
				);
			}
			return stalledResponse(new Uint8Array([80, 75]));
		});
		vi.stubGlobal("fetch", fetchMock);
		const storage = new MemorySkillStore();
		const service = await AgentSkillsService.start(createRuntime(), {
			autoLoad: false,
			storage,
		});

		await expect(
			service.install("catalog-stall", {
				downloadTimeoutMs: 25,
				throwOnDownloadError: true,
			}),
		).rejects.toMatchObject({
			code: "SKILL_DOWNLOAD_TIMEOUT",
			context: { timeoutMs: 25 },
		});
		expect(signals).toHaveLength(2);
		expect(signals[0]).toBe(signals[1]);
		expect(storage.getPackage("catalog-stall")).toBeUndefined();
	});

	it("closes a real catalog package peer when its body exceeds the deadline", async () => {
		let markPackageClosed: (() => void) | undefined;
		const packageClosed = new Promise<void>((resolve) => {
			markPackageClosed = resolve;
		});
		const server = createServer((request, response) => {
			if (request.url?.startsWith("/api/v1/skills/catalog-peer-stall")) {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ latestVersion: { version: "1.0.0" } }));
				return;
			}
			if (request.url?.startsWith("/api/v1/download")) {
				response.once("close", () => markPackageClosed?.());
				response.writeHead(200, { "content-type": "application/zip" });
				response.write(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
				return;
			}
			response.writeHead(404).end();
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const { port } = server.address() as AddressInfo;
		const storage = new MemorySkillStore();
		const service = await AgentSkillsService.start(createRuntime(), {
			autoLoad: false,
			registryUrl: `http://127.0.0.1:${port}`,
			storage,
		});

		try {
			await expect(
				service.install("catalog-peer-stall", {
					downloadTimeoutMs: 120,
					throwOnDownloadError: true,
				}),
			).rejects.toMatchObject({ code: "SKILL_DOWNLOAD_TIMEOUT" });
			await expect(packageClosed).resolves.toBeUndefined();
			expect(storage.getPackage("catalog-peer-stall")).toBeUndefined();
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});

	it("bounds a stalled catalog-details body before package fetch or persistence", async () => {
		let requestCount = 0;
		let markDetailsClosed: (() => void) | undefined;
		const detailsClosed = new Promise<void>((resolve) => {
			markDetailsClosed = resolve;
		});
		const server = createServer((_request, response) => {
			requestCount += 1;
			response.once("close", () => markDetailsClosed?.());
			response.writeHead(200, { "content-type": "application/json" });
			response.write('{"latestVersion":');
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const { port } = server.address() as AddressInfo;
		const storage = new MemorySkillStore();
		const service = await AgentSkillsService.start(createRuntime(), {
			autoLoad: false,
			registryUrl: `http://127.0.0.1:${port}`,
			storage,
		});
		const startedAt = Date.now();

		try {
			await expect(
				service.install("metadata-stall", {
					downloadTimeoutMs: 500,
					throwOnDownloadError: true,
				}),
			).rejects.toMatchObject({
				code: "SKILL_DOWNLOAD_TIMEOUT",
				context: { timeoutMs: 500 },
			});
			expect(Date.now() - startedAt).toBeLessThan(2_500);
			await expect(detailsClosed).resolves.toBeUndefined();
			expect(requestCount).toBe(1);
			expect(storage.getPackage("metadata-stall")).toBeUndefined();
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});

	it("closes a real GitHub SKILL.md peer when its body exceeds the deadline", async () => {
		const nativeFetch = globalThis.fetch;
		let markSkillClosed: (() => void) | undefined;
		const skillClosed = new Promise<void>((resolve) => {
			markSkillClosed = resolve;
		});
		const server = createServer((request, response) => {
			if (request.url === "/SKILL.md") {
				response.once("close", () => markSkillClosed?.());
				response.writeHead(200, { "content-type": "text/markdown" });
				response.write("---\nname: github-skill-peer-stall\n");
				return;
			}
			response.writeHead(404).end();
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const { port } = server.address() as AddressInfo;
		vi.stubGlobal(
			"fetch",
			vi.fn((input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/SKILL.md")) {
					return nativeFetch(`http://127.0.0.1:${port}/SKILL.md`, init);
				}
				return nativeFetch(input, init);
			}),
		);
		const storage = new MemorySkillStore();
		const service = await AgentSkillsService.start(createRuntime(), {
			autoLoad: false,
			storage,
		});

		try {
			await expect(
				service.installFromGitHub("owner/github-skill-peer-stall", {
					downloadTimeoutMs: 120,
					throwOnDownloadError: true,
				}),
			).rejects.toMatchObject({ code: "SKILL_DOWNLOAD_TIMEOUT" });
			await expect(skillClosed).resolves.toBeUndefined();
			expect(storage.getPackage("github-skill-peer-stall")).toBeUndefined();
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});

	it("does not persist GitHub SKILL.md when its README stalls", async () => {
		const signals: AbortSignal[] = [];
		const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
			if (init?.signal) signals.push(init.signal);
			if (fetchMock.mock.calls.length === 1) {
				return new Response(
					"---\nname: github-stall\ndescription: test\n---\n# Test\n",
				);
			}
			return stalledResponse("# partial readme");
		});
		vi.stubGlobal("fetch", fetchMock);
		const storage = new MemorySkillStore();
		const service = await AgentSkillsService.start(createRuntime(), {
			autoLoad: false,
			storage,
		});

		await expect(
			service.installFromGitHub("owner/github-stall", {
				downloadTimeoutMs: 25,
				throwOnDownloadError: true,
			}),
		).rejects.toMatchObject({
			code: "SKILL_DOWNLOAD_TIMEOUT",
			context: { timeoutMs: 25 },
		});
		expect(signals).toHaveLength(2);
		expect(signals[0]).toBe(signals[1]);
		expect(storage.getPackage("github-stall")).toBeUndefined();
	});

	it("closes a real GitHub README peer when its body exceeds the deadline", async () => {
		const nativeFetch = globalThis.fetch;
		let markReadmeClosed: (() => void) | undefined;
		const readmeClosed = new Promise<void>((resolve) => {
			markReadmeClosed = resolve;
		});
		const server = createServer((request, response) => {
			if (request.url === "/SKILL.md") {
				response.writeHead(200, { "content-type": "text/markdown" });
				response.end(
					"---\nname: github-peer-stall\ndescription: test\n---\n# Test\n",
				);
				return;
			}
			if (request.url === "/README.md") {
				response.once("close", () => markReadmeClosed?.());
				response.writeHead(200, { "content-type": "text/markdown" });
				response.write("# partial README");
				return;
			}
			response.writeHead(404).end();
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const { port } = server.address() as AddressInfo;
		vi.stubGlobal(
			"fetch",
			vi.fn((input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/SKILL.md")) {
					return nativeFetch(`http://127.0.0.1:${port}/SKILL.md`, init);
				}
				if (url.endsWith("/README.md")) {
					return nativeFetch(`http://127.0.0.1:${port}/README.md`, init);
				}
				return nativeFetch(input, init);
			}),
		);
		const storage = new MemorySkillStore();
		const service = await AgentSkillsService.start(createRuntime(), {
			autoLoad: false,
			storage,
		});

		try {
			await expect(
				service.installFromGitHub("owner/github-peer-stall", {
					downloadTimeoutMs: 120,
					throwOnDownloadError: true,
				}),
			).rejects.toMatchObject({ code: "SKILL_DOWNLOAD_TIMEOUT" });
			await expect(readmeClosed).resolves.toBeUndefined();
			expect(storage.getPackage("github-peer-stall")).toBeUndefined();
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});

	it("bounds a real loopback response that sends headers and then stalls", async () => {
		const server = createServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/markdown" });
			response.write("---\nname: loopback-stall\n");
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const { port } = server.address() as AddressInfo;
		const storage = new MemorySkillStore();
		const service = await AgentSkillsService.start(createRuntime(), {
			autoLoad: false,
			storage,
		});
		const startedAt = Date.now();

		try {
			await expect(
				service.installFromUrl(`http://127.0.0.1:${port}/loopback-stall.md`, {
					downloadTimeoutMs: 75,
					throwOnDownloadError: true,
				}),
			).rejects.toMatchObject({
				code: "SKILL_DOWNLOAD_TIMEOUT",
				context: { timeoutMs: 75 },
			});
			expect(Date.now() - startedAt).toBeLessThan(1_500);
			expect(storage.getPackage("loopback-stall")).toBeUndefined();
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});
});
