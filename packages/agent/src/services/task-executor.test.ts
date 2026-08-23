/**
 * Behavioral coverage for TaskExecutorRegistry: register/get/unregister, empty
 * and single-element queues, explicit-type preference over capability probing,
 * fall-through when the typed executor refuses or is missing, insertion-order
 * ties, empty spec.type, overwrite of the same type, and removal of a missing
 * key. Drives the real registry with in-process TaskExecutor collaborators.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { TaskExecutor, TaskResult, TaskSpec } from "./task-executor.ts";
import { TaskExecutorRegistry } from "./task-executor.ts";

const runtime = { agentId: "runtime-1" } as unknown as IAgentRuntime;

function spec(
  overrides: {
    id?: string;
    description?: string;
    type?: string;
    metadata?: Record<string, unknown>;
    agentType?: string;
  } = {},
): TaskSpec {
  const next: TaskSpec = {
    id: overrides.id ?? "task-1",
    description: overrides.description ?? "do the work",
    type: overrides.type ?? "coding",
  };
  if (overrides.metadata !== undefined) {
    next.metadata = overrides.metadata;
  }
  if (overrides.agentType !== undefined) {
    next.agentType = overrides.agentType;
  }
  return next;
}

function makeExecutor(
  type: string,
  accept: (task: TaskSpec, agentRuntime: IAgentRuntime) => boolean = (task) =>
    task.type === type,
): TaskExecutor {
  return {
    type,
    description: `${type} executor`,
    canHandle(task, agentRuntime) {
      return accept(task, agentRuntime);
    },
    async execute(task): Promise<TaskResult> {
      return { taskId: task.id, success: true, output: type };
    },
    async abort() {},
  };
}

describe("TaskExecutorRegistry", () => {
  it("starts empty: getAll is [], get and findExecutor miss", () => {
    const registry = new TaskExecutorRegistry();

    expect(registry.getAll()).toEqual([]);
    expect(registry.get("coding")).toBeUndefined();
    expect(registry.findExecutor(spec(), runtime)).toBeUndefined();
  });

  it("register then get and getAll return that single executor", () => {
    const registry = new TaskExecutorRegistry();
    const coding = makeExecutor("coding");
    registry.register(coding);

    expect(registry.get("coding")).toBe(coding);
    expect(registry.getAll()).toEqual([coding]);
    expect(registry.findExecutor(spec({ type: "coding" }), runtime)).toBe(
      coding,
    );
  });

  it("register of the same type replaces the previous executor", () => {
    const registry = new TaskExecutorRegistry();
    const first = makeExecutor("coding");
    const second = makeExecutor("coding");
    registry.register(first);
    registry.register(second);

    expect(registry.get("coding")).toBe(second);
    expect(registry.getAll()).toEqual([second]);
    expect(registry.findExecutor(spec({ type: "coding" }), runtime)).toBe(
      second,
    );
  });

  it("overwrite of an existing type keeps the original Map insertion slot", () => {
    const registry = new TaskExecutorRegistry();
    const research = makeExecutor("research");
    const firstCoding = makeExecutor("coding");
    const secondCoding = makeExecutor("coding");
    registry.register(research);
    registry.register(firstCoding);
    registry.register(secondCoding);

    expect(registry.getAll()).toEqual([research, secondCoding]);
  });

  it("unregister removes a registered type and leaves others in place", () => {
    const registry = new TaskExecutorRegistry();
    const coding = makeExecutor("coding");
    const research = makeExecutor("research");
    registry.register(coding);
    registry.register(research);
    registry.unregister("coding");

    expect(registry.get("coding")).toBeUndefined();
    expect(registry.get("research")).toBe(research);
    expect(registry.getAll()).toEqual([research]);
    expect(registry.findExecutor(spec({ type: "coding" }), runtime)).toBe(
      undefined,
    );
  });

  it("unregister of a missing type is a no-op", () => {
    const registry = new TaskExecutorRegistry();
    const coding = makeExecutor("coding");
    registry.register(coding);
    registry.unregister("missing");

    expect(registry.getAll()).toEqual([coding]);
    expect(registry.get("coding")).toBe(coding);
  });

  it("unregister on an empty registry does not throw", () => {
    const registry = new TaskExecutorRegistry();
    expect(() => registry.unregister("coding")).not.toThrow();
    expect(registry.getAll()).toEqual([]);
  });

  it("prefers the explicit type match over an earlier catch-all", () => {
    const registry = new TaskExecutorRegistry();
    const catchAll = makeExecutor("research", () => true);
    const coding = makeExecutor("coding");
    registry.register(catchAll);
    registry.register(coding);

    expect(registry.findExecutor(spec({ type: "coding" }), runtime)).toBe(
      coding,
    );
  });

  it("falls through when the explicit executor exists but canHandle is false", () => {
    const registry = new TaskExecutorRegistry();
    const catchAll = makeExecutor("research", () => true);
    const refusing = makeExecutor("coding", () => false);
    registry.register(catchAll);
    registry.register(refusing);

    expect(registry.findExecutor(spec({ type: "coding" }), runtime)).toBe(
      catchAll,
    );
  });

  it("falls through when spec.type is not a registered key", () => {
    const registry = new TaskExecutorRegistry();
    const byDescription = makeExecutor("research", (task) =>
      task.description.includes("cite"),
    );
    registry.register(byDescription);

    expect(
      registry.findExecutor(
        spec({ type: "unknown", description: "cite sources" }),
        runtime,
      ),
    ).toBe(byDescription);
  });

  it("skips explicit lookup when spec.type is empty and uses insertion order", () => {
    const registry = new TaskExecutorRegistry();
    const coding = makeExecutor("coding");
    const catchAll = makeExecutor("research", () => true);
    registry.register(coding);
    registry.register(catchAll);

    expect(registry.findExecutor(spec({ type: "" }), runtime)).toBe(catchAll);
  });

  it("returns the first insertion-order executor that canHandle when no explicit match", () => {
    const registry = new TaskExecutorRegistry();
    const refusing = makeExecutor("coding", () => false);
    const first = makeExecutor("research", () => true);
    const second = makeExecutor("content", () => true);
    registry.register(refusing);
    registry.register(first);
    registry.register(second);

    expect(registry.findExecutor(spec({ type: "unregistered" }), runtime)).toBe(
      first,
    );
  });

  it("returns undefined when every executor refuses", () => {
    const registry = new TaskExecutorRegistry();
    registry.register(makeExecutor("coding", () => false));
    registry.register(makeExecutor("research", () => false));

    expect(registry.findExecutor(spec({ type: "coding" }), runtime)).toBe(
      undefined,
    );
  });

  it("returns undefined when the only typed executor refuses and nothing else is registered", () => {
    const registry = new TaskExecutorRegistry();
    registry.register(makeExecutor("coding", () => false));

    expect(registry.findExecutor(spec({ type: "coding" }), runtime)).toBe(
      undefined,
    );
  });

  it("forwards the provided runtime into canHandle", () => {
    const registry = new TaskExecutorRegistry();
    const seen: IAgentRuntime[] = [];
    registry.register(
      makeExecutor("coding", (_task, agentRuntime) => {
        seen.push(agentRuntime);
        return true;
      }),
    );

    const found = registry.findExecutor(spec({ type: "coding" }), runtime);

    expect(found?.type).toBe("coding");
    expect(seen).toEqual([runtime]);
  });

  it("matches a probe-only executor on agentType when spec.type is not registered", () => {
    const registry = new TaskExecutorRegistry();
    const researcher = makeExecutor(
      "worker",
      (task) => task.agentType === "researcher",
    );
    registry.register(researcher);

    expect(
      registry.findExecutor(
        spec({ type: "ad-hoc", agentType: "researcher" }),
        runtime,
      ),
    ).toBe(researcher);
    expect(
      registry.findExecutor(
        spec({ type: "ad-hoc", agentType: "coder" }),
        runtime,
      ),
    ).toBeUndefined();
  });

  it("get misses a type that was never registered even after other inserts", () => {
    const registry = new TaskExecutorRegistry();
    registry.register(makeExecutor("coding"));

    expect(registry.get("research")).toBeUndefined();
    expect(registry.get("")).toBeUndefined();
  });
});
