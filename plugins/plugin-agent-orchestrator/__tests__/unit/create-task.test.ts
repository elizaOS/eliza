/**
 * Verifies TASKS:create.
 * Deterministic unit test with a stubbed runtime; no live model.
 */
import * as os from "node:os";
import { promoteSubactionsToActions } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// CREATE_AGENT_TASK is `TASKS { action: "create" }` (the default action).
import { createTaskAction } from "../../src/actions/tasks.js";
import { codingAgentExamplesProvider } from "../../src/providers/action-examples.js";
import {
  callback,
  memory,
  runtimeWith,
  serviceMock,
  state,
} from "../../src/test-utils/action-test-utils.js";

describe("TASKS:create", () => {
  // These pins exercise the direct-prompt spawn shapes. Under the default
  // Smithers path a create without an OrchestratorTaskService fails closed
  // by contract (durable owner required before ACP spawn), which is covered
  // by the widget-emission suite.
  let previousSmithers: string | undefined;
  beforeEach(() => {
    previousSmithers = process.env.ELIZA_ORCHESTRATOR_SMITHERS;
    process.env.ELIZA_ORCHESTRATOR_SMITHERS = "0";
  });
  afterEach(() => {
    if (previousSmithers === undefined) {
      delete process.env.ELIZA_ORCHESTRATOR_SMITHERS;
    } else {
      process.env.ELIZA_ORCHESTRATOR_SMITHERS = previousSmithers;
    }
  });
  it("executes a declared history alias on the promoted create tool instead of stranding", async () => {
    // New virtual-pin contract: explicit declared discriminators execute.
    const create = promoteSubactionsToActions(createTaskAction).find(
      (action) => action.name === "TASKS_CREATE",
    );
    if (!create) throw new Error("TASKS_CREATE was not promoted");
    const svc = serviceMock();

    const result = await create.handler(
      runtimeWith(svc),
      memory({ task: "show task history" }),
      state,
      { parameters: { operation: "history", task: "show task history" } },
      callback(),
    );

    expect((result as { success?: boolean }).success).toBe(true);
    expect(svc.spawnSession).not.toHaveBeenCalled();
  });

  it("exposes create plus capability-based issue and scheduling routes", () => {
    const actions = createTaskAction.parameters?.find(
      (parameter) => parameter.name === "action",
    )?.schema.enum;
    expect(actions).toContain("create");
    expect(createTaskAction.routingHint).toContain("TASKS_MANAGE_ISSUES");
    expect(createTaskAction.routingHint).toContain("TRIGGER_CREATE");
    expect(createTaskAction.routingHint).toContain(
      "whichever is exposed this turn",
    );
  });

  it("keeps the coding TASKS parent out of generic owner task context", () => {
    expect(createTaskAction.contexts).toContain("code");
    expect(createTaskAction.contexts).toContain("automation");
    expect(createTaskAction.contexts).not.toContain("tasks");
    expect(codingAgentExamplesProvider.contexts).toContain("code");
    expect(codingAgentExamplesProvider.contexts).not.toContain("tasks");
  });

  it("surfaces TASKS whenever the ACP service is ready", async () => {
    // Validation surfaces TASKS as soon as the ACP service is registered;
    // routing personal-LifeOps phrasings off this action is the Stage-1
    // router's job (regex on message text is fragile across plurals,
    // languages, and paraphrases).
    expect(
      await createTaskAction.validate(
        runtimeWith(serviceMock()),
        memory({ task: "implement feature" }),
        state,
      ),
    ).toBe(true);
    expect(
      await createTaskAction.validate(
        runtimeWith(undefined),
        memory({ task: "implement feature" }),
        state,
      ),
    ).toBe(false);
  });

  it("keeps website update requests eligible for the coding TASKS parent", async () => {
    expect(
      await createTaskAction.validate(
        runtimeWith(serviceMock()),
        memory({ text: "update the website, add some fixes" }),
        state,
      ),
    ).toBe(true);
  });

  it("keeps personal reminder wording off TASKS so LifeOps can own it", async () => {
    expect(
      await createTaskAction.validate(
        runtimeWith(serviceMock()),
        memory({ text: "set a reminder to call mom tomorrow" }),
        state,
      ),
    ).toBe(false);
  });

  it("keeps a coding request phrased as a to-do eligible for TASKS (#11028)", async () => {
    // "add a task to build ..." tripped the personal-lifeops keyword gate and
    // suppressed the coding orchestrator even for an unambiguous build request.
    // The gate now defers to the structural task classifier for build/deploy/view
    // signals, so a landing-page build phrased as a to-do stays eligible.
    expect(
      await createTaskAction.validate(
        runtimeWith(serviceMock()),
        memory({ text: "add a task to build me a landing page" }),
        state,
      ),
    ).toBe(true);
  });

  it("still routes a bare personal to-do off TASKS (no regression)", async () => {
    expect(
      await createTaskAction.validate(
        runtimeWith(serviceMock()),
        memory({ text: "add a task to buy milk" }),
        state,
      ),
    ).toBe(false);
  });

  it("supports nyx options.parameters and returns data.agents[].sessionId plus id", async () => {
    const svc = serviceMock();
    // Must be a real directory: resolveSpawnWorkdir drops an explicit workdir
    // that does not exist on disk (the planner routinely typos the path).
    const workdir = os.tmpdir();
    const result = await createTaskAction.handler(
      runtimeWith(svc),
      memory({}),
      state,
      {
        parameters: {
          action: "create",
          task: "fix bug",
          agentType: "codex",
          workdir,
          model: "gpt-5.5",
          approvalPreset: "readonly",
          timeout_ms: 1000,
        },
      },
      callback(),
    );
    expect(result?.success).toBe(true);
    // Without an OrchestratorTaskService, no [TASK:…] widget block is appended;
    // the callback still receives the prose summary.
    expect(result?.text).toBe("On it — building that now.");
    expect(result?.data?.taskId).toBeNull();
    expect(result?.data?.agents).toEqual([
      {
        id: "abcdef123456",
        sessionId: "abcdef123456",
        agentType: "codex",
        name: "agent-one",
        workdir,
        label: "fix bug",
        status: "completed",
      },
    ]);
    expect(svc.emitSessionEvent).toHaveBeenCalledWith(
      "abcdef123456",
      "task_complete",
      expect.objectContaining({ response: "done" }),
    );
    expect(svc.stopSession).toHaveBeenCalledWith("abcdef123456");
  });
  it("stamps a distinct requestVoicePart per part on a multi-part fan-out, none on a single-part create", async () => {
    // Fan-out voice scoping: genuinely parallel parts spawned from ONE user
    // message each get their own request-voice slot (part:<index>), so the
    // first part's terminal cannot gag the siblings' genuine results. A
    // single-part create keeps the bare request key — retries/cascades of a
    // single task still share one voice.
    const svc = serviceMock();
    const workdir = os.tmpdir();
    const result = await createTaskAction.handler(
      runtimeWith(svc),
      memory({}),
      state,
      {
        parameters: {
          action: "create",
          agents: "build the API | build the UI",
          agentType: "codex",
          workdir,
        },
      },
      callback(),
    );
    expect(result?.success).toBe(true);
    const parts = svc.spawnSession.mock.calls
      .map(
        (call) =>
          (call[0] as { metadata?: Record<string, unknown> }).metadata
            ?.requestVoicePart,
      )
      .sort();
    expect(parts).toEqual(["part:0", "part:1"]);

    const single = serviceMock();
    const singleResult = await createTaskAction.handler(
      runtimeWith(single),
      memory({}),
      state,
      {
        parameters: {
          action: "create",
          task: "fix bug",
          agentType: "codex",
          workdir,
        },
      },
      callback(),
    );
    expect(singleResult?.success).toBe(true);
    expect(
      (
        single.spawnSession.mock.calls[0]?.[0] as
          | { metadata?: Record<string, unknown> }
          | undefined
      )?.metadata?.requestVoicePart,
    ).toBeUndefined();
  });

  it("an inherited requestVoicePart (lane respawn) overrides the per-part mint", async () => {
    // Respawn-shares-key per lane: a synthetic respawn inbound carries its
    // predecessor's part in content.metadata — the create must inherit it
    // verbatim instead of minting a fresh one, or the respawned lane would
    // claim a different voice slot and double-post.
    const svc = serviceMock();
    const workdir = os.tmpdir();
    const result = await createTaskAction.handler(
      runtimeWith(svc),
      memory({
        text: "continue the lane",
        metadata: {
          subAgent: true,
          spawnRootMessageId: "root-1",
          requestVoicePart: "lane:w1:a",
        },
      }),
      state,
      {
        parameters: {
          action: "create",
          task: "continue the lane",
          agentType: "codex",
          workdir,
        },
      },
      callback(),
    );
    expect(result?.success).toBe(true);
    const spawnCall = svc.spawnSession.mock.calls[0]?.[0] as
      | { metadata?: Record<string, unknown> }
      | undefined;
    expect(spawnCall?.metadata?.requestVoicePart).toBe("lane:w1:a");
    expect(spawnCall?.metadata?.spawnRootMessageId).toBe("root-1");
  });

  it("handles missing service, auth error, generic failure", async () => {
    expect(
      (
        await createTaskAction.handler(
          runtimeWith(undefined),
          memory(),
          state,
          { parameters: { action: "create" } },
          callback(),
        )
      )?.error,
    ).toBe("SERVICE_UNAVAILABLE");
    const auth = serviceMock({
      spawnSession: vi.fn(async () => {
        throw new Error("auth failed");
      }),
    });
    const authResult = await createTaskAction.handler(
      runtimeWith(auth),
      memory({ task: "x" }),
      state,
      { parameters: { action: "create" } },
      callback(),
    );
    expect(authResult?.success).toBe(false);
    expect(authResult?.data?.agents).toBeDefined();
    const fail = serviceMock({
      sendPrompt: vi.fn(async () => ({
        sessionId: "abcdef123456",
        response: "",
        finalText: "",
        stopReason: "error",
        durationMs: 1,
        error: "boom",
      })),
    });
    expect(
      (
        await createTaskAction.handler(
          runtimeWith(fail),
          memory({ task: "x" }),
          state,
          { parameters: { action: "create" } },
          callback(),
        )
      )?.success,
    ).toBe(false);
  });
});
