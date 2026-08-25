/**
 * Registry and install fetch deadline tests for `AgentSkillsService`. The
 * harness checks every call site and uses real Node HTTP sockets to prove the
 * deadline covers both stalled response headers and stalled body streams.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemorySkillStore } from "../storage";
import { AgentSkillsService } from "./skills";

function createRuntime(
	settings: Record<string, unknown> = {},
): IAgentRuntime {
	return {
		getSetting: vi.fn((key: string) => settings[key]),
		logger: {
			debug: vi.fn(),
			error: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
		},
	} as unknown as IAgentRuntime;
}

async function listenLocally(
	onRequest: Parameters<typeof createServer>[0],
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
	const server = createServer(onRequest);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		},
	};
}

describe("AgentSkillsService fetch timeouts", () => {
	let service: AgentSkillsService;

	beforeEach(async () => {
		service = (await AgentSkillsService.start(createRuntime(), {
			autoLoad: false,
			storage: new MemorySkillStore(),
		})) as AgentSkillsService;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("1. getCatalog supplies an AbortSignal timeout to fetch", async () => {
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ items: [] }), {
				headers: { "content-type": "application/json" },
				status: 200,
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await service.getCatalog({ forceRefresh: true });

		expect(fetchMock).toHaveBeenCalledOnce();
		const options = fetchMock.mock.calls[0][1] as RequestInit;
		expect(options.signal).toBeInstanceOf(AbortSignal);
	});

	it("2. search supplies an AbortSignal timeout to fetch", async () => {
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ results: [] }), {
				headers: { "content-type": "application/json" },
				status: 200,
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await service.search("weather", 10, { forceRefresh: true });

		expect(fetchMock).toHaveBeenCalledOnce();
		const options = fetchMock.mock.calls[0][1] as RequestInit;
		expect(options.signal).toBeInstanceOf(AbortSignal);
	});

	it("3. getSkillDetails supplies an AbortSignal timeout to fetch", async () => {
		const fetchMock = vi.fn(async () =>
			new Response(
				JSON.stringify({
					slug: "test-skill",
					latestVersion: { version: "1.0.0" },
				}),
				{
					headers: { "content-type": "application/json" },
					status: 200,
				},
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		await service.getSkillDetails("test-skill", { forceRefresh: true });

		expect(fetchMock).toHaveBeenCalledOnce();
		const options = fetchMock.mock.calls[0][1] as RequestInit;
		expect(options.signal).toBeInstanceOf(AbortSignal);
	});

	it("4. install (package download) supplies an AbortSignal timeout to fetch", async () => {
		const detailsResponse = new Response(
			JSON.stringify({
				slug: "test-skill",
				latestVersion: { version: "1.0.0" },
			}),
			{
				headers: { "content-type": "application/json" },
				status: 200,
			},
		);

		const downloadResponse = new Response(new Uint8Array([0x50, 0x4b, 0x05, 0x06]), {
			headers: { "content-type": "application/zip" },
			status: 200,
		});

		const fetchMock = vi.fn(async (url: string) => {
			if (String(url).includes("/api/v1/skills/")) return detailsResponse;
			if (String(url).includes("/api/v1/download")) return downloadResponse;
			return new Response("not found", { status: 404 });
		});
		vi.stubGlobal("fetch", fetchMock);

		await service.install("test-skill", "1.0.0");

		const downloadCall = fetchMock.mock.calls.find((call) =>
			String(call[0]).includes("/api/v1/download"),
		);
		expect(downloadCall).toBeDefined();
		const options = downloadCall?.[1] as RequestInit;
		expect(options.signal).toBeInstanceOf(AbortSignal);
	});

	it("5 & 6. installFromGitHub supplies AbortSignal timeouts for SKILL.md and README.md", async () => {
		const skillMd = "---\nname: GitHub Skill\ndescription: A test skill\n---\n# Docs";
		const readmeMd = "# Readme Docs";

		const fetchMock = vi.fn(async (url: string) => {
			if (String(url).endsWith("SKILL.md")) {
				return new Response(skillMd, { status: 200 });
			}
			if (String(url).endsWith("README.md")) {
				return new Response(readmeMd, { status: 200 });
			}
			return new Response("not found", { status: 404 });
		});
		vi.stubGlobal("fetch", fetchMock);

		await service.installFromGitHub("owner/repo", { force: true });

		const skillMdCall = fetchMock.mock.calls.find((call) =>
			String(call[0]).endsWith("SKILL.md"),
		);
		expect(skillMdCall).toBeDefined();
		const skillMdOptions = skillMdCall?.[1] as RequestInit;
		expect(skillMdOptions.signal).toBeInstanceOf(AbortSignal);

		const readmeCall = fetchMock.mock.calls.find((call) =>
			String(call[0]).endsWith("README.md"),
		);
		expect(readmeCall).toBeDefined();
		const readmeOptions = readmeCall?.[1] as RequestInit;
		expect(readmeOptions.signal).toBeInstanceOf(AbortSignal);
	}, 15_000);

	it("7. installFromUrl supplies an AbortSignal timeout to fetch", async () => {
		const skillMd = "---\nname: URL Skill\ndescription: A url test skill\n---\n# Docs";
		const fetchMock = vi.fn(async () =>
			new Response(skillMd, {
				headers: { "content-type": "text/markdown" },
				status: 200,
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await service.installFromUrl("https://example.com/SKILL.md");

		expect(fetchMock).toHaveBeenCalledOnce();
		const options = fetchMock.mock.calls[0][1] as RequestInit;
		expect(options.signal).toBeInstanceOf(AbortSignal);
	});

	it("supports an explicit service deadline override", async () => {
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ items: [] }), { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const timeoutSignal = new AbortController().signal;
		const timeoutSpy = vi
			.spyOn(AbortSignal, "timeout")
			.mockReturnValue(timeoutSignal);
		const localService = (await AgentSkillsService.start(createRuntime(), {
			autoLoad: false,
			fetchTimeoutMs: 1_234,
			storage: new MemorySkillStore(),
		})) as AgentSkillsService;

		await localService.getCatalog({ forceRefresh: true });

		expect(timeoutSpy).toHaveBeenCalledWith(1_234);
		expect(fetchMock.mock.calls[0][1]).toMatchObject({ signal: timeoutSignal });
	});

	it("allows the service deadline to be explicitly disabled", async () => {
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ items: [] }), { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
		const localService = (await AgentSkillsService.start(createRuntime(), {
			autoLoad: false,
			fetchTimeoutMs: null,
			storage: new MemorySkillStore(),
		})) as AgentSkillsService;

		await localService.getCatalog({ forceRefresh: true });

		expect(timeoutSpy).not.toHaveBeenCalled();
		expect(fetchMock.mock.calls[0][1]).toMatchObject({ signal: undefined });
	});

	it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
		"rejects invalid service deadline %s",
		async (fetchTimeoutMs) => {
			await expect(
				AgentSkillsService.start(createRuntime(), {
					autoLoad: false,
					fetchTimeoutMs,
					storage: new MemorySkillStore(),
				}),
			).rejects.toThrow(
				"fetchTimeoutMs must be a positive bounded integer or null",
			);
		},
	);

	it("aborts a real Node fetch that stalls before response headers", async () => {
		let requestCount = 0;
		const endpoint = await listenLocally(() => {
			requestCount += 1;
			// Deliberately never send response headers.
		});
		const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
		vi.spyOn(AbortSignal, "timeout").mockImplementation(() => nativeTimeout(40));
		const localService = (await AgentSkillsService.start(
			createRuntime(),
			{
				autoLoad: false,
				registryUrl: endpoint.baseUrl,
				storage: new MemorySkillStore(),
			},
		)) as AgentSkillsService;

		try {
			const startedAt = performance.now();
			await expect(
				localService.getCatalog({ forceRefresh: true }),
			).resolves.toEqual([]);
			expect(performance.now() - startedAt).toBeLessThan(2_000);
			const requestCountAfterTimeout = requestCount;

			// A timed-out catalog fetch enters the existing cooldown even when a
			// caller forces refresh, so retries cannot hammer an unhealthy registry.
			await expect(
				localService.getCatalog({ forceRefresh: true }),
			).resolves.toEqual([]);
			expect(requestCount).toBe(requestCountAfterTimeout);
		} finally {
			await endpoint.close();
		}
	});

	it("aborts a real Node response while its package body is stalled", async () => {
		const endpoint = await listenLocally((_request, response) => {
			response.writeHead(200, { "content-type": "text/markdown" });
			response.write("---\nname: stalled\ndescription: partial");
			// Deliberately never finish the response body.
		});
		const storage = new MemorySkillStore();
		const localService = (await AgentSkillsService.start(createRuntime(), {
			autoLoad: false,
			fetchTimeoutMs: 40,
			storage,
		})) as AgentSkillsService;

		try {
			const startedAt = performance.now();
			await expect(
				localService.installFromUrl(`${endpoint.baseUrl}/SKILL.md`, {
					slug: "stalled",
				}),
			).resolves.toBe(false);
			expect(performance.now() - startedAt).toBeLessThan(2_000);
			expect(storage.getPackage("stalled")).toBeUndefined();
		} finally {
			await endpoint.close();
		}
	});
});
