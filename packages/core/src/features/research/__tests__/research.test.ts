import { beforeEach, describe, expect, it } from "vitest";
import type { IAgentRuntime, Memory, UUID } from "../../../types/index.ts";
import { createResearchAction } from "../actions/create-research.ts";
import { listResearchAction } from "../actions/list-research.ts";
import { ResearchService } from "../services/researchService.ts";

const AGENT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" as UUID;
const USER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" as UUID;

function makeRuntime(overrides?: Partial<IAgentRuntime>): IAgentRuntime {
	return {
		agentId: AGENT_ID,
		getSetting: () => null,
		...overrides,
	} as unknown as IAgentRuntime;
}

function makeMessage(
	overrides?: Partial<Memory["content"]>,
	entityId?: UUID,
): Memory {
	return {
		id: "msg-1" as UUID,
		entityId: entityId ?? USER_ID,
		roomId: "room-1" as UUID,
		agentId: AGENT_ID,
		content: {
			text: "",
			...overrides,
		},
	} as unknown as Memory;
}

describe("ResearchService", () => {
	let service: ResearchService;
	let runtime: IAgentRuntime;

	beforeEach(() => {
		runtime = makeRuntime();
		const tmpDir = `/tmp/research-test-${Math.random().toString(36).slice(2)}`;
		process.env.RESEARCH_BASE_PATH = tmpDir;
		service = new ResearchService(runtime);
	});

	it("create returns a research thread with correct fields", async () => {
		const research = await service.create(AGENT_ID, USER_ID, {
			title: "elizaOS overview",
			query: "what is elizaOS",
		});
		expect(research.id).toBeTruthy();
		expect(research.title).toBe("elizaOS overview");
		expect(research.status).toBe("open");
		expect(research.agentId).toBe(AGENT_ID);
		expect(research.userId).toBe(USER_ID);
		expect(research.findings).toHaveLength(1);
		expect(research.findings[0].query).toBe("what is elizaOS");
	});

	it("list returns created research thread", async () => {
		await service.create(AGENT_ID, USER_ID, {
			title: "Customer churn",
			query: "why do customers churn",
		});
		const threads = await service.list(AGENT_ID, USER_ID, { status: "open" });
		expect(threads.length).toBeGreaterThanOrEqual(1);
		const found = threads.find((r) => r.title === "Customer churn");
		expect(found).toBeTruthy();
	});

	it("continue adds a finding to an existing thread", async () => {
		const created = await service.create(AGENT_ID, USER_ID, {
			title: "Migration guide",
			query: "how to migrate to v5",
		});
		expect(created.findings).toHaveLength(1);

		const continued = await service.continue(
			AGENT_ID,
			USER_ID,
			created.id,
			"breaking changes in v5",
		);
		expect(continued.findings).toHaveLength(2);
		expect(continued.findings[1].query).toBe("breaking changes in v5");
	});

	it("get retrieves a thread by id", async () => {
		const created = await service.create(AGENT_ID, USER_ID, {
			title: "TypeScript tips",
			query: "advanced TypeScript patterns",
		});
		const fetched = await service.get(AGENT_ID, USER_ID, created.id);
		expect(fetched).toBeTruthy();
		expect(fetched?.id).toBe(created.id);
		expect(fetched?.title).toBe("TypeScript tips");
	});

	it("edit changes title and status", async () => {
		const created = await service.create(AGENT_ID, USER_ID, {
			title: "Old title",
			query: "initial query",
		});
		const edited = await service.edit(AGENT_ID, USER_ID, created.id, {
			title: "New title",
			status: "resolved",
		});
		expect(edited.title).toBe("New title");
		expect(edited.status).toBe("resolved");
	});

	it("delete removes the thread entirely", async () => {
		const created = await service.create(AGENT_ID, USER_ID, {
			title: "To remove",
			query: "query to remove",
		});
		const removed = await service.delete(AGENT_ID, USER_ID, created.id);
		expect(removed).toBe(true);

		const threads = await service.list(AGENT_ID, USER_ID, { status: "all" });
		expect(threads.find((r) => r.id === created.id)).toBeUndefined();
	});

	it("list with status filter returns only matching threads", async () => {
		const open = await service.create(AGENT_ID, USER_ID, {
			title: "Open research",
			query: "open query",
		});
		const resolved = await service.create(AGENT_ID, USER_ID, {
			title: "Resolved research",
			query: "resolved query",
		});
		await service.edit(AGENT_ID, USER_ID, resolved.id, {
			status: "resolved",
		});

		const openThreads = await service.list(AGENT_ID, USER_ID, {
			status: "open",
		});
		expect(openThreads.find((r) => r.id === open.id)).toBeTruthy();
		expect(openThreads.find((r) => r.id === resolved.id)).toBeUndefined();

		const resolvedThreads = await service.list(AGENT_ID, USER_ID, {
			status: "resolved",
		});
		expect(resolvedThreads.find((r) => r.id === resolved.id)).toBeTruthy();
		expect(resolvedThreads.find((r) => r.id === open.id)).toBeUndefined();
	});

	it("list respects limit", async () => {
		await service.create(AGENT_ID, USER_ID, { title: "R1", query: "q1" });
		await service.create(AGENT_ID, USER_ID, { title: "R2", query: "q2" });
		await service.create(AGENT_ID, USER_ID, { title: "R3", query: "q3" });
		const limited = await service.list(AGENT_ID, USER_ID, {
			status: "all",
			limit: 2,
		});
		expect(limited.length).toBeLessThanOrEqual(2);
	});

	it("get returns null for a nonexistent id", async () => {
		const notFound = await service.get(
			AGENT_ID,
			USER_ID,
			"nonexistent-id" as UUID,
		);
		expect(notFound).toBeNull();
	});
});

describe("createResearchAction handler", () => {
	it("returns success with id when title and query provided", async () => {
		process.env.RESEARCH_BASE_PATH = `/tmp/research-action-${Math.random().toString(36).slice(2)}`;
		const runtime = makeRuntime();
		const message = makeMessage({}, USER_ID);
		const result = await createResearchAction.handler(
			runtime,
			message,
			undefined,
			{ parameters: { title: "elizaOS overview", query: "what is elizaOS" } },
			undefined,
		);
		expect(result.success).toBe(true);
		expect(result.data?.id).toBeTruthy();
	});

	it("returns failure when no title", async () => {
		const runtime = makeRuntime();
		const message = makeMessage({}, USER_ID);
		const result = await createResearchAction.handler(
			runtime,
			message,
			undefined,
			{},
			undefined,
		);
		expect(result.success).toBe(false);
	});
});

describe("listResearchAction handler", () => {
	it("returns threads after create", async () => {
		process.env.RESEARCH_BASE_PATH = `/tmp/research-list-${Math.random().toString(36).slice(2)}`;
		const runtime = makeRuntime();
		const message = makeMessage({}, USER_ID);

		await createResearchAction.handler(
			runtime,
			message,
			undefined,
			{
				parameters: {
					title: "Listed research",
					query: "initial listed query",
				},
			},
			undefined,
		);

		const result = await listResearchAction.handler(
			runtime,
			message,
			undefined,
			{},
			undefined,
		);
		expect(result.success).toBe(true);
		expect((result.data as { count: number })?.count).toBeGreaterThanOrEqual(1);
	});
});
