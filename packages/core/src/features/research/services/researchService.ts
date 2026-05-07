import crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { IAgentRuntime } from "../../../types/index.ts";
import { logger } from "../../../types/index.ts";
import type { UUID } from "../../../types/primitives.ts";
import type {
	CreateResearchInput,
	EditResearchInput,
	ListResearchOptions,
	Research,
	ResearchFinding,
} from "../types.ts";

const RESEARCH_DIR = "research";

function defaultResearchBasePath(): string {
	const stateDir =
		process.env.MILADY_STATE_DIR ??
		process.env.ELIZA_STATE_DIR ??
		path.join(os.homedir(), ".milady");
	return path.join(stateDir, RESEARCH_DIR);
}

function researchFilePath(
	basePath: string,
	agentId: UUID,
	userId: UUID,
): string {
	const safeAgent = agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
	const safeUser = userId.replace(/[^a-zA-Z0-9_-]/g, "_");
	return path.join(basePath, safeAgent, `${safeUser}.json`);
}

function readBasePath(runtime: IAgentRuntime | undefined): string {
	const direct = runtime?.getSetting?.("RESEARCH_BASE_PATH");
	if (typeof direct === "string" && direct.trim()) {
		return direct.trim();
	}
	const envValue = process.env.RESEARCH_BASE_PATH;
	if (typeof envValue === "string" && envValue.trim()) {
		return envValue.trim();
	}
	return defaultResearchBasePath();
}

type ResearchStore = {
	version: 1;
	threads: Research[];
};

/**
 * Per-user research thread service. Persists to a JSON file per (agentId, userId) pair.
 * Uses an in-memory Map as a write-through cache to avoid repeated disk reads
 * within a single process lifetime.
 *
 * Integration point: CREATE_RESEARCH and CONTINUE_RESEARCH store placeholder findings.
 * The sub-planner can wire WEB_SEARCH results into the `summary` and `sources` fields
 * by calling `appendFinding` with the actual search result content.
 */
export class ResearchService {
	private readonly basePath: string;
	private readonly cache = new Map<string, Research[]>();

	constructor(runtime: IAgentRuntime) {
		this.basePath = readBasePath(runtime);
	}

	private storeKey(agentId: UUID, userId: UUID): string {
		return `${agentId}:${userId}`;
	}

	private async ensureDirectory(agentId: UUID): Promise<void> {
		const agentDir = path.join(
			this.basePath,
			agentId.replace(/[^a-zA-Z0-9_-]/g, "_"),
		);
		await fs.mkdir(agentDir, { recursive: true });
	}

	private async readStore(agentId: UUID, userId: UUID): Promise<Research[]> {
		const key = this.storeKey(agentId, userId);
		const cached = this.cache.get(key);
		if (cached !== undefined) {
			return cached;
		}

		await this.ensureDirectory(agentId);
		const filePath = researchFilePath(this.basePath, agentId, userId);

		try {
			const raw = await fs.readFile(filePath, "utf8");
			const parsed = JSON.parse(raw) as Partial<ResearchStore> | null;
			if (!parsed || !Array.isArray(parsed.threads)) {
				return [];
			}
			const threads = parsed.threads.filter(
				(r): r is Research =>
					r !== null &&
					typeof r === "object" &&
					typeof r.id === "string" &&
					typeof r.agentId === "string" &&
					typeof r.userId === "string" &&
					typeof r.title === "string" &&
					typeof r.status === "string" &&
					Array.isArray(r.findings) &&
					typeof r.createdAt === "number" &&
					typeof r.updatedAt === "number",
			);
			this.cache.set(key, threads);
			return threads;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				this.cache.set(key, []);
				return [];
			}
			logger.warn(
				"[ResearchService] Failed to read research store:",
				error instanceof Error ? error.message : String(error),
			);
			return [];
		}
	}

	private async writeStore(
		agentId: UUID,
		userId: UUID,
		threads: Research[],
	): Promise<void> {
		await this.ensureDirectory(agentId);
		const filePath = researchFilePath(this.basePath, agentId, userId);
		const store: ResearchStore = { version: 1, threads };
		const tempPath = `${filePath}.tmp-${crypto.randomUUID()}`;
		await fs.writeFile(tempPath, JSON.stringify(store, null, 2), "utf8");
		await fs.rename(tempPath, filePath);
		this.cache.set(this.storeKey(agentId, userId), threads);
	}

	async create(
		agentId: UUID,
		userId: UUID,
		input: CreateResearchInput,
	): Promise<Research> {
		const threads = await this.readStore(agentId, userId);
		const now = Date.now();

		// Placeholder finding — sub-planner wires in actual WEB_SEARCH results
		const initialFinding: ResearchFinding = {
			query: input.query.trim(),
			summary: `Initial query: "${input.query.trim()}" — findings pending.`,
			capturedAt: now,
		};

		const research: Research = {
			id: crypto.randomUUID() as UUID,
			agentId,
			userId,
			title: input.title.trim(),
			status: "open",
			findings: [initialFinding],
			createdAt: now,
			updatedAt: now,
		};
		threads.unshift(research);
		await this.writeStore(agentId, userId, threads);
		logger.info(
			`[ResearchService] Created research ${research.id}: "${research.title}"`,
		);
		return research;
	}

	async continue(
		agentId: UUID,
		userId: UUID,
		id: UUID,
		query: string,
	): Promise<Research> {
		const threads = await this.readStore(agentId, userId);
		const index = threads.findIndex((r) => r.id === id);
		if (index === -1) {
			throw new Error(`Research not found: ${id}`);
		}

		const now = Date.now();
		// Placeholder finding — sub-planner wires in actual WEB_SEARCH results
		const newFinding: ResearchFinding = {
			query: query.trim(),
			summary: `Follow-up query: "${query.trim()}" — findings pending.`,
			capturedAt: now,
		};

		const updated: Research = {
			...threads[index],
			findings: [...threads[index].findings, newFinding],
			updatedAt: now,
		};
		threads[index] = updated;
		await this.writeStore(agentId, userId, threads);
		logger.info(`[ResearchService] Continued research ${id}`);
		return updated;
	}

	async get(agentId: UUID, userId: UUID, id: UUID): Promise<Research | null> {
		const threads = await this.readStore(agentId, userId);
		return threads.find((r) => r.id === id) ?? null;
	}

	async list(
		agentId: UUID,
		userId: UUID,
		opts: ListResearchOptions = {},
	): Promise<Research[]> {
		const threads = await this.readStore(agentId, userId);
		const statusFilter = opts.status ?? "open";
		const filtered = threads.filter((r) => {
			if (statusFilter === "all") {
				return true;
			}
			return r.status === statusFilter;
		});
		const limit = opts.limit;
		return typeof limit === "number" && limit > 0
			? filtered.slice(0, limit)
			: filtered;
	}

	async edit(
		agentId: UUID,
		userId: UUID,
		id: UUID,
		patch: EditResearchInput,
	): Promise<Research> {
		const threads = await this.readStore(agentId, userId);
		const index = threads.findIndex((r) => r.id === id);
		if (index === -1) {
			throw new Error(`Research not found: ${id}`);
		}
		const existing = threads[index];
		const updated: Research = {
			...existing,
			...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
			...(patch.status !== undefined ? { status: patch.status } : {}),
			updatedAt: Date.now(),
		};
		threads[index] = updated;
		await this.writeStore(agentId, userId, threads);
		logger.info(`[ResearchService] Edited research ${id}`);
		return updated;
	}

	async delete(agentId: UUID, userId: UUID, id: UUID): Promise<boolean> {
		const threads = await this.readStore(agentId, userId);
		const index = threads.findIndex((r) => r.id === id);
		if (index === -1) {
			return false;
		}
		threads.splice(index, 1);
		await this.writeStore(agentId, userId, threads);
		logger.info(`[ResearchService] Deleted research ${id}`);
		return true;
	}
}

const servicesByRuntime = new WeakMap<IAgentRuntime, ResearchService>();

export function getResearchService(runtime: IAgentRuntime): ResearchService {
	const existing = servicesByRuntime.get(runtime);
	if (existing) {
		return existing;
	}
	const service = new ResearchService(runtime);
	servicesByRuntime.set(runtime, service);
	return service;
}
