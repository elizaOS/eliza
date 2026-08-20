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

		const optedOut = createSkillDownloadLifecycle({ downloadTimeoutMs: null });
		expect(optedOut.timeoutMs).toBeNull();
		expect(optedOut.signal.aborted).toBe(false);
		optedOut.dispose();
	});

	it.each([
		0,
		-1,
		0.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		MAX_SKILL_DOWNLOAD_TIMEOUT_MS + 1,
	])("rejects invalid deadline override %s", (downloadTimeoutMs) => {
		expect(() =>
			createSkillDownloadLifecycle({ downloadTimeoutMs }),
		).toThrow(
			expect.objectContaining({ code: "SKILL_DOWNLOAD_INVALID_TIMEOUT" }),
		);
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
			downloadTimeoutMs: null,
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
