/**
 * Verifies startup loads local Agent Skills without an implicit registry call,
 * while preserving the explicit catalog-sync opt-in.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Agent Skills startup catalog policy", () => {
	it("does not contact the remote registry by default", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await AgentSkillsService.start(createRuntime(), {
			autoLoad: false,
			storage: new MemorySkillStore(),
		});

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("syncs during startup only when explicitly enabled", async () => {
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ items: [] }), {
				headers: { "content-type": "application/json" },
				status: 200,
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await AgentSkillsService.start(
			createRuntime({ SKILLS_SYNC_CATALOG_ON_START: true }),
			{
				autoLoad: false,
				storage: new MemorySkillStore(),
			},
		);

		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("stops when the registry repeats a pagination cursor", async () => {
		const runtime = createRuntime();
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ items: [{ slug: "known-good" }] }), {
					status: 200,
				}),
			)
			.mockImplementation(async () =>
				new Response(
					JSON.stringify({
						items: [{ slug: "duplicate-skill" }],
						nextCursor: "same-cursor",
					}),
					{ headers: { "content-type": "application/json" }, status: 200 },
				),
			);
		vi.stubGlobal("fetch", fetchMock);

		const service = await AgentSkillsService.start(runtime, {
			autoLoad: false,
			storage: new MemorySkillStore(),
		});
		await service.syncCatalog();
		await expect(service.syncCatalog()).rejects.toThrow(
			"Catalog pagination repeated cursor same-cursor",
		);

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(service.getCatalogStats().total).toBe(1);
		expect(runtime.logger.warn).toHaveBeenCalledWith(
			expect.stringContaining("repeated cursor same-cursor"),
		);
	});

	it("encodes cursors before requesting the next catalog page", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ items: [], nextCursor: " a b&c " }), {
					status: 200,
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ items: [] }), { status: 200 }),
			);
		vi.stubGlobal("fetch", fetchMock);

		const service = await AgentSkillsService.start(createRuntime(), {
			autoLoad: false,
			storage: new MemorySkillStore(),
		});
		await service.syncCatalog();

		expect(fetchMock.mock.calls[1]?.[0]).toContain(
			"cursor=%20a%20b%26c%20",
		);
	});

	it("syncs catalogs beyond the former fixed page ceiling", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ items: [{ slug: "known-good" }] }), {
					status: 200,
				}),
			)
			.mockImplementation(async () =>
				new Response(
					JSON.stringify({
						items: [{ slug: `skill-${fetchMock.mock.calls.length}` }],
						nextCursor:
							fetchMock.mock.calls.length === 102
								? undefined
								: `cursor-${fetchMock.mock.calls.length}`,
					}),
					{ status: 200 },
				),
			);
		vi.stubGlobal("fetch", fetchMock);

		const service = await AgentSkillsService.start(createRuntime(), {
			autoLoad: false,
			storage: new MemorySkillStore(),
		});
		await service.syncCatalog();
		await expect(service.syncCatalog()).resolves.toMatchObject({
			added: 100,
			updated: 101,
		});

		expect(fetchMock).toHaveBeenCalledTimes(102);
		expect(service.getCatalogStats().total).toBe(101);
	});

	it("returns null when memory mode scan results file contains corrupted JSON without throwing", async () => {
		const memoryStore = new MemorySkillStore();
		await memoryStore.savePackage({
			slug: "corrupted-scan-skill",
			files: [{ name: ".scan-results.json", content: "{ invalid json format, unclosed \"" }],
		});

		const service = await AgentSkillsService.start(createRuntime(), {
			autoLoad: false,
			storage: memoryStore,
		});

		const report = await service.getSkillScanReport("corrupted-scan-skill");
		expect(report).toBeNull();
	});
});
