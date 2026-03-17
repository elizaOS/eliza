import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { completeTaskAction } from "../src/actions/completeTask";
import { createPlanAction } from "../src/actions/createPlan";
import { getPlanAction } from "../src/actions/getPlan";
import { updatePlanAction } from "../src/actions/updatePlan";
import { planStatusProvider } from "../src/providers/planStatus";
import {
  decodePlan,
  encodePlan,
  formatPlan,
  generatePlanId,
  generateTaskId,
  getPlanProgress,
  PLAN_SOURCE,
  type Plan,
  PlanStatus,
  type Task,
  TaskStatus,
} from "../src/types";

// --- Type Utilities ---

describe("Plan Type Utilities", () => {
  it("should generate unique plan IDs", () => {
    const id1 = generatePlanId();
    const id2 = generatePlanId();
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^plan-/);
  });

  it("should generate sequential task IDs", () => {
    expect(generateTaskId(0)).toBe("task-1");
    expect(generateTaskId(1)).toBe("task-2");
    expect(generateTaskId(9)).toBe("task-10");
  });

  it("should encode and decode plan round-trip", () => {
    const plan: Plan = {
      id: "plan-test",
      title: "Test Plan",
      description: "A test plan",
      status: PlanStatus.ACTIVE,
      tasks: [
        {
          id: "task-1",
          title: "First task",
          description: "Do something",
          status: TaskStatus.PENDING,
          order: 1,
          dependencies: [],
          assignee: null,
          createdAt: Date.now(),
          completedAt: null,
        },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {},
    };

    const encoded = encodePlan(plan);
    const decoded = decodePlan(encoded);

    expect(decoded).not.toBeNull();
    expect(decoded?.id).toBe(plan.id);
    expect(decoded?.title).toBe(plan.title);
    expect(decoded?.tasks).toHaveLength(1);
    expect(decoded?.tasks[0].title).toBe("First task");
  });

  it("should return null for invalid plan data", () => {
    expect(decodePlan("not json")).toBeNull();
    expect(decodePlan("{}")).toBeNull();
    expect(decodePlan('{"id":"x"}')).toBeNull();
  });

  it("should calculate plan progress correctly", () => {
    const makePlan = (statuses: TaskStatus[]): Plan => ({
      id: "p",
      title: "t",
      description: "",
      status: PlanStatus.ACTIVE,
      tasks: statuses.map((s, i) => ({
        id: `t-${i}`,
        title: `Task ${i}`,
        description: "",
        status: s,
        order: i,
        dependencies: [],
        assignee: null,
        createdAt: 0,
        completedAt: s === TaskStatus.COMPLETED ? Date.now() : null,
      })),
      createdAt: 0,
      updatedAt: 0,
      metadata: {},
    });

    expect(getPlanProgress(makePlan([]))).toBe(0);
    expect(getPlanProgress(makePlan([TaskStatus.PENDING]))).toBe(0);
    expect(getPlanProgress(makePlan([TaskStatus.COMPLETED]))).toBe(100);
    expect(getPlanProgress(makePlan([TaskStatus.COMPLETED, TaskStatus.PENDING]))).toBe(50);
    expect(
      getPlanProgress(makePlan([TaskStatus.COMPLETED, TaskStatus.COMPLETED, TaskStatus.PENDING]))
    ).toBe(67);
  });

  it("should format plan as readable text", () => {
    const plan: Plan = {
      id: "plan-1",
      title: "Launch Plan",
      description: "Launch the website",
      status: PlanStatus.ACTIVE,
      tasks: [
        {
          id: "t-1",
          title: "Setup server",
          description: "",
          status: TaskStatus.COMPLETED,
          order: 1,
          dependencies: [],
          assignee: null,
          createdAt: 0,
          completedAt: Date.now(),
        },
        {
          id: "t-2",
          title: "Deploy code",
          description: "",
          status: TaskStatus.PENDING,
          order: 2,
          dependencies: ["t-1"],
          assignee: "alice",
          createdAt: 0,
          completedAt: null,
        },
      ],
      createdAt: 0,
      updatedAt: 0,
      metadata: {},
    };

    const formatted = formatPlan(plan);
    expect(formatted).toContain("Launch Plan");
    expect(formatted).toContain("50%");
    expect(formatted).toContain("[x] Setup server");
    expect(formatted).toContain("[ ] Deploy code");
    expect(formatted).toContain("@alice");
  });
});

// --- Action Metadata ---

describe("CREATE_PLAN Action", () => {
  it("should have correct action metadata", () => {
    expect(createPlanAction.name).toBe("CREATE_PLAN");
    expect(createPlanAction.description).toBeTruthy();
    expect(createPlanAction.similes).toContain("create-plan");
    expect(createPlanAction.examples.length).toBeGreaterThan(0);
  });

  it("should validate when runtime has createMemory", async () => {
    const runtime = {
      createMemory: vi.fn(),
    } as Partial<IAgentRuntime> as IAgentRuntime;

    const message = { agentId: "a", roomId: "r", content: { text: "t" } } as Memory;
    expect(await createPlanAction.validate(runtime, message)).toBe(true);
  });

  it("should create a plan with LLM-generated tasks", async () => {
    const mockCreate = vi.fn().mockResolvedValue("plan-uuid");

    const runtime = {
      createMemory: mockCreate,
      agentId: "agent-1",
      useModel: vi.fn().mockResolvedValue(
        JSON.stringify({
          title: "Website Launch",
          description: "Steps to launch the website",
          tasks: [
            { title: "Setup hosting", description: "Configure server" },
            { title: "Deploy code", description: "Push to production" },
          ],
        })
      ),
    } as Partial<IAgentRuntime> as IAgentRuntime;

    const message = {
      agentId: "agent-1",
      roomId: "room-1",
      userId: "user-1",
      content: { text: "Plan the website launch" },
    } as Memory;

    const result = await createPlanAction.handler(runtime, message);
    expect(result.success).toBe(true);
    expect(result.text).toContain("Website Launch");
    expect(result.text).toContain("2 tasks");
    expect(mockCreate).toHaveBeenCalledOnce();
  });
});

describe("UPDATE_PLAN Action", () => {
  it("should have correct action metadata", () => {
    expect(updatePlanAction.name).toBe("UPDATE_PLAN");
    expect(updatePlanAction.similes).toContain("update-plan");
  });

  it("should report no plans when none exist", async () => {
    const runtime = {
      getMemories: vi.fn().mockResolvedValue([]),
    } as Partial<IAgentRuntime> as IAgentRuntime;

    const message = {
      agentId: "a",
      roomId: "r",
      content: { text: "update" },
    } as Memory;

    const result = await updatePlanAction.handler(runtime, message);
    expect(result.success).toBe(false);
    expect(result.text).toContain("No plans found");
  });
});

describe("COMPLETE_TASK Action", () => {
  it("should have correct action metadata", () => {
    expect(completeTaskAction.name).toBe("COMPLETE_TASK");
    expect(completeTaskAction.similes).toContain("complete-task");
  });

  it("should complete a task by ID", async () => {
    const plan: Plan = {
      id: "plan-1",
      title: "Test",
      description: "Test plan",
      status: PlanStatus.ACTIVE,
      tasks: [
        {
          id: "task-1",
          title: "Do thing",
          description: "",
          status: TaskStatus.PENDING,
          order: 1,
          dependencies: [],
          assignee: null,
          createdAt: 0,
          completedAt: null,
        },
      ],
      createdAt: 0,
      updatedAt: 0,
      metadata: {},
    };

    const planMemory: Partial<Memory> = {
      id: "mem-1",
      agentId: "a",
      roomId: "r",
      content: { text: encodePlan(plan), source: PLAN_SOURCE },
      createdAt: 0,
    };

    const mockUpdateMemory = vi.fn().mockResolvedValue(true);

    const runtime = {
      getMemories: vi.fn().mockResolvedValue([planMemory]),
      updateMemory: mockUpdateMemory,
      agentId: "a",
    } as Partial<IAgentRuntime> as IAgentRuntime;

    const message = {
      agentId: "a",
      roomId: "r",
      userId: "u",
      content: { text: "complete task" },
    } as Memory;

    const options = { parameters: { taskId: "task-1" } };
    const result = await completeTaskAction.handler(runtime, message, undefined, options);

    expect(result.success).toBe(true);
    expect(result.text).toContain("Completed task");
    expect(result.text).toContain("100%");
    expect(mockUpdateMemory).toHaveBeenCalledOnce();
  });
});

describe("GET_PLAN Action", () => {
  it("should have correct action metadata", () => {
    expect(getPlanAction.name).toBe("GET_PLAN");
    expect(getPlanAction.similes).toContain("get-plan");
  });

  it("should return no plans message when empty", async () => {
    const runtime = {
      getMemories: vi.fn().mockResolvedValue([]),
    } as Partial<IAgentRuntime> as IAgentRuntime;

    const message = {
      agentId: "a",
      roomId: "r",
      content: { text: "show plans" },
    } as Memory;

    const result = await getPlanAction.handler(runtime, message);
    expect(result.success).toBe(true);
    expect(result.text).toContain("No plans found");
  });
});

// --- Plan Status Provider ---

describe("Plan Status Provider", () => {
  it("should have correct provider metadata", () => {
    expect(planStatusProvider.name).toBe("PLAN_STATUS");
    expect(planStatusProvider.description).toBeTruthy();
  });

  it("should return no plans message when empty", async () => {
    const runtime = {
      getMemories: vi.fn().mockResolvedValue([]),
    } as Partial<IAgentRuntime> as IAgentRuntime;

    const message = { agentId: "a", roomId: "r", content: { text: "" } } as Memory;
    const result = await planStatusProvider.get(runtime, message, {} as never);
    expect(result.text).toContain("No active plans");
  });

  it("should show plan status with progress", async () => {
    const plan: Plan = {
      id: "plan-1",
      title: "My Plan",
      description: "desc",
      status: PlanStatus.ACTIVE,
      tasks: [
        {
          id: "t1",
          title: "Done task",
          description: "",
          status: TaskStatus.COMPLETED,
          order: 1,
          dependencies: [],
          assignee: null,
          createdAt: 0,
          completedAt: 0,
        },
        {
          id: "t2",
          title: "Pending task",
          description: "",
          status: TaskStatus.PENDING,
          order: 2,
          dependencies: [],
          assignee: null,
          createdAt: 0,
          completedAt: null,
        },
      ],
      createdAt: 0,
      updatedAt: 0,
      metadata: {},
    };

    const planMemory: Partial<Memory> = {
      id: "mem-1",
      agentId: "a",
      roomId: "r",
      content: { text: encodePlan(plan), source: PLAN_SOURCE },
      createdAt: 0,
    };

    const runtime = {
      getMemories: vi.fn().mockResolvedValue([planMemory]),
    } as Partial<IAgentRuntime> as IAgentRuntime;

    const message = { agentId: "a", roomId: "r", content: { text: "" } } as Memory;
    const result = await planStatusProvider.get(runtime, message, {} as never);
    expect(result.text).toContain("My Plan");
    expect(result.text).toContain("50%");
    expect(result.text).toContain("1/2 tasks");
  });
});
