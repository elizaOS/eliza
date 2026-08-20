/**
 * Managed-skill transaction coverage uses real memory storage and deterministic
 * cancellation hooks to prove forced replacement, rollback, and serialization.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	MemorySkillStore,
	type PreparedSkillReplacement,
	type SkillPackage,
} from "../storage";
import { AgentSkillsService } from "./skills";

function runtime(): IAgentRuntime {
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

function skillMarkdown(slug: string, body: string): string {
	return `---\nname: ${slug}\ndescription: ${body}\n---\n\n# ${body}\n`;
}

async function seedSkill(
	storage: MemorySkillStore,
	slug: string,
	body: string,
): Promise<void> {
	await storage.savePackage({
		slug,
		files: [{ name: "SKILL.md", content: skillMarkdown(slug, body) }],
	});
}

class AbortAfterPublishStore extends MemorySkillStore {
	controller: AbortController | undefined;

	override async prepareReplacement(
		pkg: SkillPackage,
		options: { signal?: AbortSignal } = {},
	): Promise<PreparedSkillReplacement> {
		const replacement = await super.prepareReplacement(pkg, options);
		return {
			...replacement,
			publish: () => {
				replacement.publish();
				this.controller?.abort(new Error("cancelled after storage publication"));
			},
		};
	}
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("managed skill install transactions", () => {
	it("preserves a prior package and loaded skill when a forced candidate cannot load", async () => {
		const storage = new MemorySkillStore();
		await seedSkill(storage, "demo", "old instructions");
		const service = await AgentSkillsService.start(runtime(), {
			autoLoad: true,
			storage,
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response("not valid skill frontmatter", {
					headers: { "content-type": "text/markdown" },
				}),
			),
		);

		await expect(
			service.installFromUrl("https://skills.example/demo.md", {
				slug: "demo",
				force: true,
			}),
		).resolves.toBe(false);

		expect(await storage.loadSkillContent("demo")).toContain("old instructions");
		expect(service.getSkillInstructions("demo")?.body).toContain(
			"old instructions",
		);
	}, 15_000);

	it("replaces the loaded cache with freshly validated forced content", async () => {
		const storage = new MemorySkillStore();
		await seedSkill(storage, "demo", "old instructions");
		const service = await AgentSkillsService.start(runtime(), {
			autoLoad: true,
			storage,
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response(skillMarkdown("demo", "new instructions"), {
					headers: { "content-type": "text/markdown" },
				}),
			),
		);

		await expect(
			service.installFromUrl("https://skills.example/demo.md", {
				slug: "demo",
				force: true,
			}),
		).resolves.toBe(true);
		expect(service.getSkillInstructions("demo")?.body).toContain(
			"new instructions",
		);
		expect(service.getSkillInstructions("demo")?.body).not.toContain(
			"old instructions",
		);
	});

	it("rolls storage and every runtime map back when cancellation lands after publish", async () => {
		const storage = new AbortAfterPublishStore();
		await seedSkill(storage, "demo", "old instructions");
		const service = await AgentSkillsService.start(runtime(), {
			autoLoad: true,
			storage,
		});
		const controller = new AbortController();
		storage.controller = controller;
		const internals = service as unknown as {
			eligibilityCache: Map<string, unknown>;
			loadedSkills: Map<string, unknown>;
			scanStatusMap: Map<string, string>;
		};
		const oldLoaded = internals.loadedSkills.get("demo");
		const oldEligibility = { eligible: false, checkedAt: 1 };
		internals.eligibilityCache.set("demo", oldEligibility);
		internals.scanStatusMap.set("demo", "warning");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response(skillMarkdown("demo", "new instructions"), {
					headers: { "content-type": "text/markdown" },
				}),
			),
		);

		await expect(
			service.installFromUrl("https://skills.example/demo.md", {
				slug: "demo",
				force: true,
				signal: controller.signal,
				throwOnDownloadError: true,
			}),
		).rejects.toMatchObject({ code: "SKILL_DOWNLOAD_ABORTED" });

		expect(await storage.loadSkillContent("demo")).toContain("old instructions");
		expect(internals.loadedSkills.get("demo")).toBe(oldLoaded);
		expect(internals.scanStatusMap.get("demo")).toBe("warning");
		expect(internals.eligibilityCache.get("demo")).toBe(oldEligibility);
	});

	it("serializes concurrent installs of the same slug before network work", async () => {
		const storage = new MemorySkillStore();
		const service = await AgentSkillsService.start(runtime(), {
			autoLoad: false,
			storage,
		});
		let resolveFirst: ((response: Response) => void) | undefined;
		const firstResponse = new Promise<Response>((resolve) => {
			resolveFirst = resolve;
		});
		const fetchMock = vi
			.fn()
			.mockImplementationOnce(async () => firstResponse)
			.mockImplementationOnce(async () =>
				new Response(skillMarkdown("demo", "second instructions"), {
					headers: { "content-type": "text/markdown" },
				}),
			);
		vi.stubGlobal("fetch", fetchMock);

		const first = service.installFromUrl("https://skills.example/demo-first.md", {
			slug: "demo",
		});
		const second = service.installFromUrl("https://skills.example/demo-second.md", {
			slug: "demo",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		resolveFirst?.(
			new Response(skillMarkdown("demo", "first instructions"), {
				headers: { "content-type": "text/markdown" },
			}),
		);

		await expect(first).resolves.toBe(true);
		await expect(second).resolves.toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(service.getSkillInstructions("demo")?.body).toContain(
			"second instructions",
		);
	});
});
