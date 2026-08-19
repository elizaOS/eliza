/**
 * Unit tests for `AgentSkillsService` fetch timeout deadlines: asserts that
 * all 7 remote registry, search, detail, and download fetch call sites
 * supply an AbortSignal timeout.
 */

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
	});

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
});
