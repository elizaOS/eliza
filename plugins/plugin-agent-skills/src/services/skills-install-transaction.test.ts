/**
 * Managed-skill transaction coverage uses real memory storage and deterministic
 * cancellation hooks to prove forced replacement, rollback, and serialization.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createSkillPackage,
	FileSystemSkillStore,
	type ISkillStorage,
	MemorySkillStore,
	type PreparedSkillReplacement,
	type SkillPackage,
} from "../storage";
import { AgentSkillsService } from "./skills";

const temporaryRoots: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	temporaryRoots.push(root);
	return root;
}

function runtime(): IAgentRuntime {
	return {
		getSetting: vi.fn(() => undefined),
		getCache: vi.fn(async () => undefined),
		setCache: vi.fn(async () => true),
		reportError: vi.fn(),
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

class LegacySkillStore implements ISkillStorage {
	readonly type = "memory" as const;
	readonly backing = new MemorySkillStore();
	onSave?: () => void;
	initialize = () => this.backing.initialize();
	listSkills = () => this.backing.listSkills();
	hasSkill = (slug: string) => this.backing.hasSkill(slug);
	loadSkillContent = (slug: string) => this.backing.loadSkillContent(slug);
	loadFile = (slug: string, relativePath: string) =>
		this.backing.loadFile(slug, relativePath);
	listFiles = (slug: string, subdir?: string) =>
		this.backing.listFiles(slug, subdir);
	async saveSkill(pkg: SkillPackage): Promise<void> {
		await this.backing.saveSkill(pkg);
		this.onSave?.();
	}
	deleteSkill = (slug: string) => this.backing.deleteSkill(slug);
	getSkillPath = (slug: string) => this.backing.getSkillPath(slug);
}

afterEach(async () => {
	vi.unstubAllGlobals();
	await Promise.all(
		temporaryRoots.splice(0).map((root) =>
			fs.rm(root, { recursive: true, force: true }),
		),
	);
});

describe("managed skill install transactions", () => {
	it("hydrates the exact persisted scan authorization before direct runtime use", async () => {
		const skillsDir = await temporaryDirectory("managed-skill-restart-gate-");
		const storage = new FileSystemSkillStore(skillsDir);
		await storage.initialize();
		await storage.saveSkill(
			createSkillPackage("restart-warning", [
				{
					name: "SKILL.md",
					content: skillMarkdown("restart-warning", "Visit https://evil.example"),
				},
			]),
		);
		const report = {
			scannedAt: "2026-08-20T00:00:00.000Z",
			status: "warning" as const,
			summary: { scannedFiles: 1, critical: 0, warn: 1, info: 0 },
			findings: [
				{
					ruleId: "external-url",
					severity: "warn" as const,
					file: "SKILL.md",
					line: 6,
					message: "External URL",
					evidence: "example",
				},
			],
			manifestFindings: [],
			skillPath: storage.getSkillPath("restart-warning"),
		};
		await fs.writeFile(
			path.join(storage.getSkillPath("restart-warning"), ".scan-results.json"),
			JSON.stringify(report),
		);
		const first = await AgentSkillsService.start(runtime(), {
			autoLoad: true,
			storage,
			skillsDir,
		});
		expect(first.isSkillEnabled("restart-warning")).toBe(false);
		expect(first.setSkillEnabled("restart-warning", true)).toBe(false);
		const digest = (
			first as unknown as { currentScanDigests: Map<string, string> }
		).currentScanDigests.get("restart-warning") as string;

		const restartRuntime = runtime();
		vi.mocked(restartRuntime.getCache).mockImplementation(async (key: string) => {
			if (key === "eliza:skill-scan-acknowledgments") {
				return { "restart-warning": { reportDigest: digest } } as never;
			}
			if (key === "eliza:skill-preferences") {
				return { "restart-warning": true } as never;
			}
			return undefined;
		});
		const restarted = await AgentSkillsService.start(restartRuntime, {
			autoLoad: true,
			storage,
			skillsDir,
		});
		expect(restarted.isSkillEnabled("restart-warning")).toBe(true);
		expect(restarted.getSkillInstructions("restart-warning")?.body).toContain(
			"evil.example",
		);
	});

	it("loads live marketplace skills for runtime use and reveals managed fallback", async () => {
		const workspaceDir = await temporaryDirectory("marketplace-runtime-");
		const skillsDir = path.join(workspaceDir, "skills");
		const managedDir = await temporaryDirectory("marketplace-managed-");
		const storage = new FileSystemSkillStore(managedDir);
		await storage.initialize();
		await storage.saveSkill(
			createSkillPackage("shared", [
				{ name: "SKILL.md", content: skillMarkdown("shared", "managed body") },
			]),
		);
		const service = await AgentSkillsService.start(runtime(), {
			autoLoad: true,
			storage,
			skillsDir: managedDir,
			workspaceSkillsDir: skillsDir,
		});
		const marketplaceDir = path.join(skillsDir, ".marketplace", "shared");
		await fs.mkdir(path.join(marketplaceDir, "references"), { recursive: true });
		await fs.writeFile(
			path.join(marketplaceDir, "SKILL.md"),
			skillMarkdown("shared", "marketplace body"),
		);
		await fs.writeFile(
			path.join(marketplaceDir, "references", "proof.md"),
			"marketplace reference",
		);
		await fs.writeFile(
			path.join(marketplaceDir, ".scan-results.json"),
			JSON.stringify({
				scannedAt: "2026-08-20T00:00:00.000Z",
				status: "clean",
				summary: { scannedFiles: 2, critical: 0, warn: 0, info: 0 },
				findings: [],
				manifestFindings: [],
				skillPath: marketplaceDir,
			}),
		);
		await service.refreshMarketplaceSkill("shared");
		expect(service.getLoadedSkill("shared")?.source).toBe("marketplace");
		expect(service.getSkillInstructions("shared")?.body).toContain(
			"marketplace body",
		);
		expect(
			(await service.getEligibleSkills()).some(
				(skill) => skill.slug === "shared" && skill.source === "marketplace",
			),
		).toBe(true);
		expect(await service.readReference("shared", "proof.md")).toBe(
			"marketplace reference",
		);
		const directWorkspaceDir = path.join(skillsDir, "shared");
		await fs.mkdir(directWorkspaceDir, { recursive: true });
		await fs.writeFile(
			path.join(directWorkspaceDir, "SKILL.md"),
			skillMarkdown("shared", "workspace body"),
		);
		await fs.writeFile(
			path.join(directWorkspaceDir, ".scan-results.json"),
			JSON.stringify({
				scannedAt: "2026-08-20T00:01:00.000Z",
				status: "warning",
				summary: { scannedFiles: 1, critical: 0, warn: 1, info: 0 },
				findings: [
					{
						ruleId: "external-url",
						severity: "warn",
						file: "SKILL.md",
						line: 1,
						message: "External URL",
						evidence: "example",
					},
				],
				manifestFindings: [],
				skillPath: directWorkspaceDir,
			}),
		);
		await service.refreshMarketplaceSkill("shared");
		expect(service.getLoadedSkill("shared")?.source).toBe("workspace");
		const workspaceDigest = (
			service as unknown as { currentScanDigests: Map<string, string> }
		).currentScanDigests.get("shared") as string;
		expect(service.acknowledgeSkillScan("shared", workspaceDigest)).toBe(true);
		expect(
			service.setSkillEnabled("shared", true, {
				reportDigest: workspaceDigest,
			}),
		).toBe(true);
		await service.refreshMarketplaceSkill("shared");
		expect(service.isSkillEnabled("shared")).toBe(true);
		await fs.rm(directWorkspaceDir, { recursive: true });
		await service.refreshMarketplaceSkill("shared");
		expect(service.getLoadedSkill("shared")?.source).toBe("marketplace");

		await fs.rm(marketplaceDir, { recursive: true });
		await service.refreshMarketplaceSkill("shared");
		expect(service.getLoadedSkill("shared")?.source).toBe("managed");
		expect(service.getSkillInstructions("shared")?.body).toContain("managed body");
	});

	it("applies denylist precedence to marketplace startup and live reconciliation", async () => {
		const workspaceDir = await temporaryDirectory("marketplace-denied-");
		const skillsDir = path.join(workspaceDir, "skills");
		const marketplaceDir = path.join(skillsDir, ".marketplace", "denied");
		await fs.mkdir(marketplaceDir, { recursive: true });
		await fs.writeFile(
			path.join(marketplaceDir, "SKILL.md"),
			skillMarkdown("denied", "must not load"),
		);
		await fs.writeFile(
			path.join(marketplaceDir, ".scan-results.json"),
			JSON.stringify({
				scannedAt: "2026-08-20T00:00:00.000Z",
				status: "clean",
				summary: { scannedFiles: 1, critical: 0, warn: 0, info: 0 },
				findings: [],
				manifestFindings: [],
				skillPath: marketplaceDir,
			}),
		);
		const service = await AgentSkillsService.start(runtime(), {
			autoLoad: true,
			storage: new MemorySkillStore(),
			workspaceSkillsDir: skillsDir,
			allowlist: ["denied"],
			denylist: ["denied"],
		});
		expect(service.getLoadedSkill("denied")).toBeUndefined();
		await service.refreshMarketplaceSkill("denied");
		expect(service.getLoadedSkill("denied")).toBeUndefined();
	});

	it("keeps finding-bearing skills disabled until the exact report is acknowledged and enabled", async () => {
		const storage = new MemorySkillStore();
		const service = await AgentSkillsService.start(runtime(), {
			autoLoad: false,
			storage,
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response(
					`${skillMarkdown("warning-skill", "warning")}\nVisit https://evil.example/path`,
					{ headers: { "content-type": "text/markdown" } },
				),
			),
		);
		await expect(
			service.installFromUrl("https://skills.example/warning.md", {
				slug: "warning-skill",
			}),
		).resolves.toBe(true);
		expect(service.getSkillScanStatus("warning-skill")).toBe("warning");
		expect(service.isSkillEnabled("warning-skill")).toBe(false);
		const internals = service as unknown as {
			currentScanDigests: Map<string, string>;
		};
		const digest = internals.currentScanDigests.get("warning-skill");
		expect(digest).toMatch(/^[a-f0-9]{64}$/);
		expect(
			service.acknowledgeSkillScan("warning-skill", "0".repeat(64)),
		).toBe(false);
		expect(service.acknowledgeSkillScan("warning-skill", digest as string)).toBe(
			true,
		);
		expect(service.isSkillEnabled("warning-skill")).toBe(false);
		expect(
			service.setSkillEnabled("warning-skill", true, {
				reportDigest: digest,
			}),
		).toBe(true);
		expect(service.isSkillEnabled("warning-skill")).toBe(true);
	});
	it("removes prepared storage, cache state, and lock entry together", async () => {
		const skillsDir = await temporaryDirectory("managed-skill-uninstall-");
		const storage = new FileSystemSkillStore(skillsDir);
		await storage.initialize();
		await storage.saveSkill(
			createSkillPackage("demo", [
				{ name: "SKILL.md", content: skillMarkdown("demo", "managed") },
			]),
		);
		await fs.mkdir(path.join(skillsDir, ".cache"), { recursive: true });
		await fs.writeFile(
			path.join(skillsDir, ".cache", "lock.json"),
			JSON.stringify({
				demo: { version: "1.0.0", installedAt: new Date().toISOString() },
			}),
		);
		const service = await AgentSkillsService.start(runtime(), {
			autoLoad: true,
			storage,
			skillsDir,
		});

		await expect(service.uninstall("demo")).resolves.toBe(true);
		expect(await storage.hasSkill("demo")).toBe(false);
		expect(service.getLoadedSkill("demo")).toBeUndefined();
		expect(
			JSON.parse(
				await fs.readFile(path.join(skillsDir, ".cache", "lock.json"), "utf-8"),
			),
		).toEqual({});
	});

	it("does not remove a prepared skill for a pre-aborted caller", async () => {
		const storage = new MemorySkillStore();
		await seedSkill(storage, "demo", "managed");
		const service = await AgentSkillsService.start(runtime(), {
			autoLoad: true,
			storage,
		});
		const controller = new AbortController();
		controller.abort(new Error("disconnected"));

		await expect(
			service.uninstall("demo", { signal: controller.signal }),
		).rejects.toThrow("disconnected");
		expect(await storage.hasSkill("demo")).toBe(true);
		expect(service.getLoadedSkill("demo")?.source).toBe("managed");
	});

	it("reveals a scanned bundled fallback immediately after managed removal", async () => {
		const storage = new MemorySkillStore();
		await seedSkill(storage, "demo", "managed");
		const fallbackDir = await temporaryDirectory("bundled-skill-fallback-");
		const fallbackStorage = new FileSystemSkillStore(fallbackDir);
		await fallbackStorage.initialize();
		await fallbackStorage.saveSkill(
			createSkillPackage("demo", [
				{ name: "SKILL.md", content: skillMarkdown("demo", "bundled") },
				{
					name: ".scan-results.json",
					content: JSON.stringify({
						scannedAt: new Date().toISOString(),
						status: "warning",
						findings: [{ ruleId: "test" }],
						manifestFindings: [],
					}),
				},
			]),
		);
		const service = await AgentSkillsService.start(runtime(), {
			autoLoad: true,
			storage,
		});
		const internals = service as unknown as {
			bundledStorages: Map<string, FileSystemSkillStore>;
		};
		internals.bundledStorages.set(fallbackDir, fallbackStorage);

		await expect(service.uninstall("demo")).resolves.toBe(true);
		expect(service.getLoadedSkill("demo")?.source).toBe("bundled");
		expect(service.getSkillInstructions("demo")?.body).toContain("bundled");
		expect(service.getSkillScanStatus("demo")).toBe("warning");
	});
	it("keeps legacy custom storage compatible and treats save success as commit", async () => {
		const storage = new LegacySkillStore();
		const controller = new AbortController();
		storage.onSave = () => controller.abort(new Error("abort at legacy save"));
		const service = await AgentSkillsService.start(runtime(), {
			autoLoad: false,
			storage,
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response(skillMarkdown("legacy", "legacy instructions"), {
					headers: { "content-type": "text/markdown" },
				}),
			),
		);

		await expect(
			service.installFromUrl("https://skills.example/legacy.md", {
				slug: "legacy",
				signal: controller.signal,
				throwOnDownloadError: true,
			}),
		).resolves.toBe(true);
		expect(await storage.loadSkillContent("legacy")).toContain(
			"legacy instructions",
		);
		await expect(service.uninstall("legacy")).resolves.toBe(true);
		expect(await storage.hasSkill("legacy")).toBe(false);
	});
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

	it("merges concurrent different-slug lockfile commits", async () => {
		const skillsDir = await temporaryDirectory("managed-skill-lock-");
		const service = await AgentSkillsService.start(runtime(), {
			autoLoad: false,
			skillsDir,
			storageType: "filesystem",
		});
		const transaction = service as unknown as {
			commitCandidate(
				pkg: SkillPackage,
				options: { version: string },
			): Promise<unknown>;
		};

		await Promise.all([
			transaction.commitCandidate(
				createSkillPackage("first", [
					{ name: "SKILL.md", content: skillMarkdown("first", "First") },
				]),
				{ version: "1.0.0" },
			),
			transaction.commitCandidate(
				createSkillPackage("second", [
					{ name: "SKILL.md", content: skillMarkdown("second", "Second") },
				]),
				{ version: "2.0.0" },
			),
		]);

		const lockfile = JSON.parse(
			await fs.readFile(path.join(skillsDir, ".cache", "lock.json"), "utf-8"),
		) as Record<string, { version: string }>;
		expect(lockfile.first?.version).toBe("1.0.0");
		expect(lockfile.second?.version).toBe("2.0.0");
	});

	it("fails closed without publishing when an existing lock entry is malformed", async () => {
		const skillsDir = await temporaryDirectory("managed-skill-lock-");
		const lockPath = path.join(skillsDir, ".cache", "lock.json");
		const malformedLock = JSON.stringify({ existing: { version: 7 } });
		await fs.mkdir(path.dirname(lockPath), { recursive: true });
		await fs.writeFile(lockPath, malformedLock, "utf-8");
		const service = await AgentSkillsService.start(runtime(), {
			autoLoad: false,
			skillsDir,
			storageType: "filesystem",
		});
		const transaction = service as unknown as {
			commitCandidate(
				pkg: SkillPackage,
				options: { version: string },
			): Promise<unknown>;
		};

		await expect(
			transaction.commitCandidate(
				createSkillPackage("candidate", [
					{
						name: "SKILL.md",
						content: skillMarkdown("candidate", "Candidate"),
					},
				]),
				{ version: "1.0.0" },
			),
		).rejects.toMatchObject({ code: "SKILL_LOCKFILE_INVALID" });
		await expect(
			fs.stat(path.join(skillsDir, "candidate")),
		).rejects.toMatchObject({ code: "ENOENT" });
		expect(await fs.readFile(lockPath, "utf-8")).toBe(malformedLock);
	});
});
