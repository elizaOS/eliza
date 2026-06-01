import { beforeEach, describe, expect, it, mock } from "bun:test";
import { logger } from "@elizaos/core";
import {
  createWorkflowDispatchService,
  registerWorkflowDispatchService,
  WORKFLOW_DISPATCH_SERVICE_TYPE,
} from "../../src/services/workflow-dispatch";
import { EMBEDDED_WORKFLOW_SERVICE_TYPE } from "../../src/services/embedded-workflow-service";

mock.module("@elizaos/core", () => ({
  logger: {
    warn: mock(() => {}),
  },
}));

type FakeExecution = { id?: string };

function makeRuntime(service: unknown = null) {
  const services = new Map<string, unknown>();
  return {
    services,
    getService: mock((type: string) =>
      type === EMBEDDED_WORKFLOW_SERVICE_TYPE ? service : null,
    ),
  };
}

function makeEmbeddedService() {
  return {
    executeWorkflow: mock(
      async (
        workflowId: string,
        options: {
          mode: string;
          triggerData: Record<string, unknown>;
          idempotencyKey?: string;
        },
      ): Promise<FakeExecution> => ({
        id: `${workflowId}:${options.idempotencyKey ?? "fresh"}`,
      }),
    ),
    findExecutionByIdempotencyKey: mock(
      async (_workflowId: string, _idempotencyKey: string) => null as FakeExecution | null,
    ),
  };
}

describe("workflow dispatch service", () => {
  beforeEach(() => {
    (logger.warn as ReturnType<typeof mock>).mockClear();
  });

  it("rejects blank workflow ids before consulting the runtime", async () => {
    const runtime = makeRuntime();
    const dispatch = createWorkflowDispatchService(runtime as never);

    await expect(dispatch.execute("   ")).resolves.toEqual({
      ok: false,
      error: "workflow id required",
    });
    expect(runtime.getService).not.toHaveBeenCalled();
  });

  it("returns a clear error when the embedded workflow service is absent", async () => {
    const dispatch = createWorkflowDispatchService(makeRuntime() as never);

    await expect(dispatch.execute("wf-1")).resolves.toEqual({
      ok: false,
      error: "embedded workflow service not registered",
    });
  });

  it("delegates to executeWorkflow with stripped payload idempotency keys", async () => {
    const embedded = makeEmbeddedService();
    const dispatch = createWorkflowDispatchService(makeRuntime(embedded) as never);

    await expect(
      dispatch.execute(" wf-1 ", {
        __idempotencyKey: "tick-1",
        source: "schedule",
      }),
    ).resolves.toEqual({
      ok: true,
      executionId: "wf-1:tick-1",
    });
    expect(embedded.findExecutionByIdempotencyKey).toHaveBeenCalledWith(
      "wf-1",
      "tick-1",
    );
    expect(embedded.executeWorkflow).toHaveBeenCalledWith("wf-1", {
      mode: "trigger",
      triggerData: { source: "schedule" },
      idempotencyKey: "tick-1",
    });
  });

  it("returns a dedup result for an existing idempotency row", async () => {
    const embedded = makeEmbeddedService();
    embedded.findExecutionByIdempotencyKey.mockImplementation(async () => ({
      id: "existing-execution",
    }));
    const dispatch = createWorkflowDispatchService(makeRuntime(embedded) as never);

    await expect(
      dispatch.execute("wf-1", {}, { idempotencyKey: "tick-1" }),
    ).resolves.toEqual({
      ok: true,
      executionId: "existing-execution",
      dedup: true,
    });
    expect(embedded.executeWorkflow).not.toHaveBeenCalled();
  });

  it("collapses concurrent dispatches with the same idempotency key", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const embedded = makeEmbeddedService();
    embedded.executeWorkflow.mockImplementation(async () => {
      await gate;
      return { id: "execution-1" };
    });
    const dispatch = createWorkflowDispatchService(makeRuntime(embedded) as never);

    const first = dispatch.execute("wf-1", {}, { idempotencyKey: "tick-1" });
    const second = dispatch.execute("wf-1", {}, { idempotencyKey: "tick-1" });
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, executionId: "execution-1" },
      { ok: true, executionId: "execution-1", dedup: true },
    ]);
    expect(embedded.executeWorkflow).toHaveBeenCalledTimes(1);
  });

  it("wraps execution failures without throwing", async () => {
    const embedded = makeEmbeddedService();
    embedded.executeWorkflow.mockImplementation(async () => {
      throw new Error("engine offline");
    });
    const dispatch = createWorkflowDispatchService(makeRuntime(embedded) as never);

    await expect(dispatch.execute("wf-1")).resolves.toEqual({
      ok: false,
      error: "engine offline",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      { src: "plugin:workflow:dispatch" },
      "Workflow execution failed for wf-1: engine offline",
    );
  });

  it("registers a stoppable service entry in the runtime services map", async () => {
    const runtime = makeRuntime(makeEmbeddedService());

    registerWorkflowDispatchService(runtime as never);

    const entries = runtime.services.get(WORKFLOW_DISPATCH_SERVICE_TYPE);
    expect(entries).toHaveLength(1);
    expect(entries?.[0]).toEqual(
      expect.objectContaining({
        capabilityDescription:
          "Executes embedded workflows by id via the in-process workflow service.",
      }),
    );
    await expect(entries?.[0].execute("wf-1")).resolves.toEqual({
      ok: true,
      executionId: "wf-1:fresh",
    });
    await expect(entries?.[0].stop()).resolves.toBeUndefined();
  });
});
