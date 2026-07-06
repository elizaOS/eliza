/**
 * Covers model-mediated dispatch rendering and the spine's default
 * notification dispatcher: instruction-voice `promptInstructions` must never
 * reach a user-visible surface verbatim, and a render failure is a typed
 * retryable dispatch failure — never a raw-instruction fallback. Deterministic:
 * the model is stubbed at the runtime boundary (`useModel`).
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  buildScheduledDispatchRenderPrompt,
  RENDER_FAILURE_RETRY_MINUTES,
  renderScheduledDispatchMessage,
} from "./dispatch-render.js";
import { ScheduledTaskRunnerService } from "./runner-service.js";

const INSTRUCTION =
  "Remind the owner to take their medication and ask how they slept.";
const RENDERED = "Time for your medication — and how did you sleep last night?";

interface NotifyCapture {
  title?: string;
  body?: string;
  category?: string;
}

function makeRuntime(opts: {
  model?: (params: { prompt: string }) => string | Promise<string>;
  notified?: NotifyCapture[];
}) {
  const modelPrompts: string[] = [];
  const reported: Array<{ scope: string; error: unknown }> = [];
  const runtime = {
    agentId: "00000000-0000-0000-0000-00000000feed",
    getService: (type: string) =>
      type === "notification" && opts.notified
        ? {
            notify: async (input: NotifyCapture) => {
              opts.notified?.push(input);
              return { id: "n1" };
            },
          }
        : null,
    ...(opts.model
      ? {
          useModel: async (_type: string, params: { prompt: string }) => {
            modelPrompts.push(params.prompt);
            return opts.model?.(params);
          },
        }
      : {}),
    reportError: (scope: string, error: unknown) => {
      reported.push({ scope, error });
    },
  } as unknown as IAgentRuntime;
  return { runtime, modelPrompts, reported };
}

function reminderInput() {
  return {
    kind: "reminder" as const,
    promptInstructions: INSTRUCTION,
    trigger: { kind: "manual" as const },
    priority: "medium" as const,
    respectsGlobalPause: false,
    source: "user_chat" as const,
    createdBy: "tester",
    ownerVisible: true,
  };
}

describe("renderScheduledDispatchMessage", () => {
  it("returns the model output for an instruction-voice prompt", async () => {
    const { runtime, modelPrompts } = makeRuntime({ model: () => RENDERED });
    const text = await renderScheduledDispatchMessage(runtime, {
      taskId: "st_1",
      firedAtIso: "2026-07-05T09:00:00.000Z",
      channelKey: "in_app",
      promptInstructions: INSTRUCTION,
      contextRequest: undefined,
    });
    expect(text).toBe(RENDERED);
    expect(modelPrompts).toHaveLength(1);
    expect(modelPrompts[0]).toContain(INSTRUCTION);
  });

  it("throws on a missing model surface, a model failure, and blank output", async () => {
    const record = {
      taskId: "st_2",
      firedAtIso: "2026-07-05T09:00:00.000Z",
      channelKey: "in_app",
      promptInstructions: INSTRUCTION,
      contextRequest: undefined,
    };
    await expect(
      renderScheduledDispatchMessage(makeRuntime({}).runtime, record),
    ).rejects.toMatchObject({ code: "SCHEDULED_DISPATCH_MODEL_UNAVAILABLE" });
    await expect(
      renderScheduledDispatchMessage(
        makeRuntime({
          model: () => {
            throw new Error("model backend down");
          },
        }).runtime,
        record,
      ),
    ).rejects.toMatchObject({ code: "SCHEDULED_DISPATCH_RENDER_FAILED" });
    await expect(
      renderScheduledDispatchMessage(
        makeRuntime({ model: () => "   \n" }).runtime,
        record,
      ),
    ).rejects.toMatchObject({ code: "SCHEDULED_DISPATCH_RENDER_EMPTY" });
  });
});

describe("default scheduled-task dispatcher (no injected deps)", () => {
  it("notifies with the model-rendered body, never the raw instruction", async () => {
    const notified: NotifyCapture[] = [];
    const { runtime, modelPrompts } = makeRuntime({
      model: () => RENDERED,
      notified,
    });
    const service = await ScheduledTaskRunnerService.start(runtime);
    const runner = service.getRunner({ agentId: String(runtime.agentId) });
    const task = await runner.schedule(reminderInput());

    const fired = await runner.fire(task.taskId);

    expect(fired.state.status).toBe("fired");
    expect(modelPrompts).toHaveLength(1);
    expect(modelPrompts[0]).toContain(INSTRUCTION);
    expect(notified).toHaveLength(1);
    expect(notified[0]?.body).toBe(RENDERED);
    expect(notified[0]?.body).not.toContain("Remind the owner to take");
  });

  it("a render failure is a typed retryable dispatch failure with reportError — nothing is notified", async () => {
    const notified: NotifyCapture[] = [];
    const { runtime, reported } = makeRuntime({
      model: () => {
        throw new Error("model backend down");
      },
      notified,
    });
    const service = await ScheduledTaskRunnerService.start(runtime);
    const runner = service.getRunner({ agentId: String(runtime.agentId) });
    const task = await runner.schedule(reminderInput());

    const fired = await runner.fire(task.taskId);

    // Retry-class failure: the runner parks the task for the render backoff
    // instead of reporting a healthy fire.
    expect(fired.metadata?.lastDispatchResult).toMatchObject({
      ok: false,
      reason: "transport_error",
      retryAfterMinutes: RENDER_FAILURE_RETRY_MINUTES,
    });
    expect(notified).toHaveLength(0);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.scope).toBe(
      "scheduling:scheduled-task:dispatch-render",
    );
  });
});

describe("buildScheduledDispatchRenderPrompt", () => {
  it("embeds the instruction as opaque payload with delivery framing and structural urgency", () => {
    const base = {
      promptInstructions: INSTRUCTION,
      firedAtIso: "2026-07-05T09:00:00.000Z",
    };
    const normal = buildScheduledDispatchRenderPrompt({
      ...base,
      intensity: "normal",
    });
    expect(normal).toContain(INSTRUCTION);
    expect(normal).toContain("not the message itself");
    expect(normal).toContain("Fired at: 2026-07-05T09:00:00.000Z");
    expect(
      buildScheduledDispatchRenderPrompt({ ...base, intensity: "urgent" }),
    ).toContain("urgent");
    expect(
      buildScheduledDispatchRenderPrompt({ ...base, intensity: "soft" }),
    ).toContain("gentle");
  });
});
