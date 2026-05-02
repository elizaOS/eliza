/**
 * USE_SKILL action tests
 *
 * Exercises the canonical skill-invocation entry point against a real
 * AgentSkillsService backed by an in-memory storage. No mocked SQL or
 * filesystem fakes — we use the real MemorySkillStore.
 */

import { describe, expect, it } from "vitest";
import {
	type SkillSearchResultWithActions,
	searchSkillsAction,
} from "../actions/search-skills";
import { useSkillAction } from "../actions/use-skill";
import { enabledSkillsProvider } from "../providers/enabled-skills";
import { AgentSkillsService } from "../services/skills";

// ─── Minimal runtime stub ──────────────────────────────────────────────
// We deliberately avoid mocking anything that touches business logic:
// the AgentSkillsService is instantiated for real, and we only stub the
// runtime surface it reads (settings, logger, getService).

interface StubRuntime {
	agentId: string;
	logger: {
		info: (...args: unknown[]) => void;
		warn: (...args: unknown[]) => void;
		error: (...args: unknown[]) => void;
		debug: (...args: unknown[]) => void;
	};
	getSetting: (key: string) => string | null;
	getService: <T = unknown>(name: string) => T | null;
	getServicesByType: () => unknown[];
}

const SAMPLE_SKILL_MD = `---
name: hello-world
description: A trivial skill used in unit tests for USE_SKILL behaviour.
---

## Instructions

Greet the user warmly and explain what hello-world does.
`;

async function buildRuntimeWithService(): Promise<{
	runtime: StubRuntime;
	service: AgentSkillsService;
}> {
	const settings: Record<string, string> = {
		SKILLS_STORAGE_TYPE: "memory",
		SKILLS_AUTO_LOAD: "false",
		SKILLS_SYNC_CATALOG_ON_START: "false",
	};
	const stub: StubRuntime = {
		agentId: "11111111-1111-1111-1111-111111111111",
		logger: {
			info: () => undefined,
			warn: () => undefined,
			error: () => undefined,
			debug: () => undefined,
		},
		getSetting: (key) => settings[key] ?? null,
		getService: () => null,
		getServicesByType: () => [],
	};

	// Cast through unknown — we only need the surface AgentSkillsService uses.
	const runtime = stub as unknown as Parameters<
		typeof AgentSkillsService.start
	>[0];
	const service = new AgentSkillsService(runtime, {
		autoLoad: false,
		syncCatalogOnStart: false,
	});
	await service.initialize();

	// Wire the service back into the stub so the action handler can resolve it.
	stub.getService = <T>(name: string): T | null =>
		name === "AGENT_SKILLS_SERVICE" ? (service as unknown as T) : null;

	return { runtime: stub, service };
}

async function loadHelloWorld(service: AgentSkillsService): Promise<void> {
	const loaded = await service.loadSkillFromContent(
		"hello-world",
		SAMPLE_SKILL_MD,
	);
	if (!loaded) throw new Error("failed to seed hello-world skill");
}

describe("USE_SKILL action", () => {
	it("returns guidance text for an enabled, eligible skill in auto mode", async () => {
		const { runtime, service } = await buildRuntimeWithService();
		await loadHelloWorld(service);

		const captured: string[] = [];
		const result = await useSkillAction.handler(
			runtime as never,
			{ content: { text: "" }, entityId: "u", roomId: "r" } as never,
			undefined,
			{ slug: "hello-world", mode: "auto" },
			async (response) => {
				captured.push(String(response.text ?? ""));
				return [];
			},
		);

		expect(result?.success).toBe(true);
		expect(result?.data).toMatchObject({
			slug: "hello-world",
			mode: "guidance",
		});
		expect(captured.join("\n")).toContain("hello-world");
	});

	it("returns a clear error when the requested skill is disabled", async () => {
		const { runtime, service } = await buildRuntimeWithService();
		await loadHelloWorld(service);
		const toggled = service.setSkillEnabled("hello-world", false);
		expect(toggled).toBe(true);

		const result = await useSkillAction.handler(
			runtime as never,
			{ content: { text: "" }, entityId: "u", roomId: "r" } as never,
			undefined,
			{ slug: "hello-world" },
		);

		expect(result?.success).toBe(false);
		expect(result?.error?.message ?? "").toContain("disabled");
		expect(result?.error?.message ?? "").toContain("ENABLE_SKILL");
	});

	it("returns a clear error when the requested skill is not installed", async () => {
		const { runtime } = await buildRuntimeWithService();

		const result = await useSkillAction.handler(
			runtime as never,
			{ content: { text: "" }, entityId: "u", roomId: "r" } as never,
			undefined,
			{ slug: "does-not-exist" },
		);

		expect(result?.success).toBe(false);
		expect(result?.error?.message ?? "").toContain("not installed");
		expect(result?.error?.message ?? "").toContain("INSTALL_SKILL");
	});

	it("rejects invocation when the slug parameter is missing", async () => {
		const { runtime } = await buildRuntimeWithService();

		const result = await useSkillAction.handler(
			runtime as never,
			{ content: { text: "" }, entityId: "u", roomId: "r" } as never,
			undefined,
			{},
		);

		expect(result?.success).toBe(false);
		expect(result?.error?.message ?? "").toContain("slug");
	});
});

describe("SEARCH_SKILLS action chips", () => {
	it("attaches an installed-and-enabled action chip set when matched", async () => {
		const { runtime, service } = await buildRuntimeWithService();
		await loadHelloWorld(service);

		// Inject a fake remote-search response by stubbing service.search.
		type SearchFn = AgentSkillsService["search"];
		const originalSearch: SearchFn = service.search.bind(service);
		service.search = (async () => [
			{
				slug: "hello-world",
				displayName: "Hello World",
				summary: "A trivial test skill",
				version: "1.0.0",
				updatedAt: 0,
				score: 1,
			},
			{
				slug: "remote-only",
				displayName: "Remote Only",
				summary: "A skill not installed locally",
				version: "1.0.0",
				updatedAt: 0,
				score: 0.5,
			},
		]) as SearchFn;

		try {
			const result = await searchSkillsAction.handler(
				runtime as never,
				{ content: { text: "hello" }, entityId: "u", roomId: "r" } as never,
				undefined,
				{},
			);

			expect(result?.success).toBe(true);
			const data = result?.data as {
				results?: SkillSearchResultWithActions[];
			};
			expect(Array.isArray(data?.results)).toBe(true);
			const installedRow = data?.results?.find((r) => r.slug === "hello-world");
			const remoteRow = data?.results?.find((r) => r.slug === "remote-only");
			expect(installedRow).toBeDefined();
			expect(installedRow?.state).toBe("enabled");
			expect(installedRow?.actions.map((a) => a.kind)).toEqual([
				"use",
				"disable",
				"copy",
				"details",
			]);
			expect(remoteRow?.state).toBe("not-installed");
			expect(remoteRow?.actions.map((a) => a.kind)).toEqual([
				"install",
				"details",
			]);
		} finally {
			service.search = originalSearch;
		}
	});

	it("returns disabled-state chips when the installed skill is disabled", async () => {
		const { runtime, service } = await buildRuntimeWithService();
		await loadHelloWorld(service);
		expect(service.setSkillEnabled("hello-world", false)).toBe(true);

		type SearchFn = AgentSkillsService["search"];
		const originalSearch: SearchFn = service.search.bind(service);
		service.search = (async () => [
			{
				slug: "hello-world",
				displayName: "Hello World",
				summary: "A trivial test skill",
				version: "1.0.0",
				updatedAt: 0,
				score: 1,
			},
		]) as SearchFn;

		try {
			const result = await searchSkillsAction.handler(
				runtime as never,
				{ content: { text: "hello" }, entityId: "u", roomId: "r" } as never,
				undefined,
				{},
			);
			const data = result?.data as {
				results?: SkillSearchResultWithActions[];
			};
			const row = data?.results?.find((r) => r.slug === "hello-world");
			expect(row?.state).toBe("disabled");
			expect(row?.actions.map((a) => a.kind)).toEqual([
				"enable",
				"copy",
				"details",
				"uninstall",
			]);
		} finally {
			service.search = originalSearch;
		}
	});
});

describe("enabled_skills provider", () => {
	it("emits a markdown list of enabled, eligible skills", async () => {
		const { runtime, service } = await buildRuntimeWithService();
		await loadHelloWorld(service);

		const result = await enabledSkillsProvider.get(
			runtime as never,
			{ content: { text: "" }, entityId: "u", roomId: "r" } as never,
			{} as never,
		);

		expect(result.text).toContain("Enabled skills");
		expect(result.text).toContain("hello-world");
		expect(result.text).toContain("USE_SKILL");
		expect(result.data).toMatchObject({ totalEnabled: 1 });
	});

	it("returns empty text when no skills are enabled", async () => {
		const { runtime, service } = await buildRuntimeWithService();
		await loadHelloWorld(service);
		expect(service.setSkillEnabled("hello-world", false)).toBe(true);

		const result = await enabledSkillsProvider.get(
			runtime as never,
			{ content: { text: "" }, entityId: "u", roomId: "r" } as never,
			{} as never,
		);

		expect(result.text).toBe("");
	});
});
