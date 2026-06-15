import { describe, expect, it } from "vitest";
import {
  type AcpLike,
  detectTurnDone,
  SmithersTaskExecutor,
} from "../../src/services/smithers-task-executor";

type PromptOut = Awaited<ReturnType<AcpLike["sendPrompt"]>>;
type SpawnOpts = Parameters<AcpLike["spawnSession"]>[0];

class FakeAcp implements AcpLike {
  spawns: SpawnOpts[] = [];
  prompts: Array<{ sessionId: string; text: string }> = [];
  resumable: { sessionId: string } | null = null;

  constructor(
    private readonly promptResult: PromptOut = {
      stopReason: "end_turn",
      finalText: "done",
    },
  ) {}

  async spawnSession(opts: SpawnOpts): Promise<{ sessionId: string }> {
    this.spawns.push(opts);
    return { sessionId: `sess-${this.spawns.length}` };
  }

  async sendPrompt(sessionId: string, text: string): Promise<PromptOut> {
    this.prompts.push({ sessionId, text });
    return this.promptResult;
  }

  async findResumableSessionByLabel(
    _label: string,
  ): Promise<{ sessionId: string } | null> {
    return this.resumable;
  }
}

describe("detectTurnDone", () => {
  it("treats a clean turn as done", () => {
    expect(detectTurnDone({ stopReason: "end_turn", finalText: "ok" })).toBe(
      true,
    );
  });
  it("treats an errored turn as not done", () => {
    expect(detectTurnDone({ error: "boom" })).toBe(false);
  });
  it("treats a truncated/interrupted turn as not done", () => {
    expect(detectTurnDone({ stopReason: "max_tokens" })).toBe(false);
    expect(detectTurnDone({ stopReason: "max_turn_requests" })).toBe(false);
    expect(detectTurnDone({ stopReason: "interrupted" })).toBe(false);
  });
});

describe("SmithersTaskExecutor", () => {
  it("spawns lazily, sends the initial prompt, reports done", async () => {
    const acp = new FakeAcp();
    const executor = new SmithersTaskExecutor(acp, { agentType: "codex" });
    const result = await executor.runTurn({
      taskId: "t1",
      runId: "t1",
      turn: 1,
      prompt: "fix the bug",
    });
    expect(acp.spawns).toHaveLength(1);
    expect(acp.spawns[0]).toMatchObject({ agentType: "codex", label: "t1" });
    expect(acp.prompts[0]).toMatchObject({
      sessionId: "sess-1",
      text: "fix the bug",
    });
    expect(result.done).toBe(true);
  });

  it("reuses one session across turns and sends the continue prompt later", async () => {
    const acp = new FakeAcp({ stopReason: "max_tokens" });
    const executor = new SmithersTaskExecutor(acp, {
      continuePrompt: "keep going",
    });
    await executor.runTurn({ taskId: "t", runId: "t", turn: 1, prompt: "P" });
    await executor.runTurn({ taskId: "t", runId: "t", turn: 2, prompt: "P" });
    expect(acp.spawns).toHaveLength(1);
    expect(acp.prompts.map((p) => p.text)).toEqual(["P", "keep going"]);
  });

  it("reattaches by label instead of spawning (durable resume)", async () => {
    const acp = new FakeAcp();
    acp.resumable = { sessionId: "resumed-1" };
    const executor = new SmithersTaskExecutor(acp);
    await executor.runTurn({ taskId: "t", runId: "t", turn: 1, prompt: "P" });
    expect(acp.spawns).toHaveLength(0);
    expect(acp.prompts[0].sessionId).toBe("resumed-1");
  });

  it("throws when a turn returns an error", async () => {
    const acp = new FakeAcp({ error: "agent failed" });
    const executor = new SmithersTaskExecutor(acp);
    await expect(
      executor.runTurn({ taskId: "t", runId: "t", turn: 1, prompt: "P" }),
    ).rejects.toThrow("agent failed");
  });

  it("uses injected approval/submit callbacks", async () => {
    const acp = new FakeAcp();
    const executor = new SmithersTaskExecutor(acp, {
      onApproval: async () => ({ approved: false, reason: "not allowed" }),
      onSubmit: async () => ({ output: { pr: "https://pr/x" } }),
    });
    expect(await executor.requestApproval({ taskId: "t", runId: "t" })).toEqual(
      {
        approved: false,
        reason: "not allowed",
      },
    );
    expect(await executor.submit({ taskId: "t", runId: "t" })).toEqual({
      output: { pr: "https://pr/x" },
    });
  });
});
