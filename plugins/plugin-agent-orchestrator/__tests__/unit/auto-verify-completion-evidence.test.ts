/**
 * Integration test for the auto goal-verifier's evidence pipeline (issue:
 * "feed the verifier real completion evidence"). Drives a real
 * {@link OrchestratorTaskService} + in-memory store through a `task_complete`
 * event and asserts that the prompt handed to the verifier model is the RICH,
 * sectioned evidence string — git changeset, deliverable/final reply, verified
 * URLs, mined build/test output — and NOT the bare event summary.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrchestratorTaskService } from "../../src/services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../../src/services/orchestrator-task-store.js";
import type { WorkspaceChangeSet } from "../../src/services/workspace-diff.js";

interface SpawnResult {
  sessionId: string;
  agentType: string;
  workdir: string;
  status: string;
  metadata?: Record<string, unknown>;
}

/** ACP fake supporting the completion path: event subscription, spawn, and the
 *  change-set read surface (`getSession` / `getChangedPaths`). */
class EvidenceFakeAcp {
  private handler:
    | ((sessionId: string, event: string, data: unknown) => void)
    | null = null;
  private counter = 0;
  private readonly sessionMeta = new Map<string, Record<string, unknown>>();
  readonly sent: { sessionId: string; message: string }[] = [];

  onSessionEvent(
    cb: (sessionId: string, event: string, data: unknown) => void,
  ): () => void {
    this.handler = cb;
    return () => {
      this.handler = null;
    };
  }

  emit(sessionId: string, event: string, data: unknown = {}): void {
    this.handler?.(sessionId, event, data);
  }

  setSessionMetadata(sessionId: string, meta: Record<string, unknown>): void {
    this.sessionMeta.set(sessionId, meta);
  }

  spawnSession(opts: Record<string, unknown>): Promise<SpawnResult> {
    this.counter += 1;
    const sessionId = `session-${this.counter}`;
    return Promise.resolve({
      sessionId,
      agentType: (opts.agentType as string | undefined) ?? "opencode",
      workdir: (opts.workdir as string | undefined) ?? "/repo",
      status: "ready",
    });
  }

  getSession(
    sessionId: string,
  ): Promise<{ metadata: Record<string, unknown> } | undefined> {
    const metadata = this.sessionMeta.get(sessionId);
    return Promise.resolve(metadata ? { metadata } : undefined);
  }

  getChangedPaths(): string[] {
    return [];
  }

  updateSessionMetadata(): Promise<void> {
    return Promise.resolve();
  }

  sendToSession(sessionId: string, message: string): Promise<void> {
    this.sent.push({ sessionId, message });
    return Promise.resolve();
  }

  stopSession(): Promise<void> {
    return Promise.resolve();
  }
}

function runtime(
  acp: EvidenceFakeAcp,
  useModel: (modelType: unknown, params: unknown) => Promise<string>,
): IAgentRuntime {
  return {
    getService: () => acp,
    useModel,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as never;
}

async function waitForPrompt(prompts: string[]): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (prompts.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function changeSet(): WorkspaceChangeSet {
  return {
    changedFiles: ["src/cache.ts"],
    diffStat: "1 file changed, 20 insertions(+)",
    diff: "diff --git a/src/cache.ts b/src/cache.ts\n+export const cache = new Map();",
    truncated: false,
    capturedAt: Date.now(),
  };
}

describe("auto-verify completion evidence pipeline", () => {
  const prevFlag = process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;
  const prevIndependent = process.env.ELIZA_ORCHESTRATOR_INDEPENDENT_VERIFY;

  beforeEach(() => {
    process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = "1";
    // Isolate the TEXT-JUDGE evidence path: the #8898 independent verifier is a
    // separate gate that precedes the judge for code-change tasks; turn it off
    // here so these assertions exercise the evidence assembly the judge sees.
    process.env.ELIZA_ORCHESTRATOR_INDEPENDENT_VERIFY = "0";
  });
  afterEach(() => {
    if (prevFlag === undefined) {
      delete process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;
    } else {
      process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = prevFlag;
    }
    if (prevIndependent === undefined) {
      delete process.env.ELIZA_ORCHESTRATOR_INDEPENDENT_VERIFY;
    } else {
      process.env.ELIZA_ORCHESTRATOR_INDEPENDENT_VERIFY = prevIndependent;
    }
  });

  it("feeds the verifier the rich sectioned evidence, not the bare summary", async () => {
    const acp = new EvidenceFakeAcp();
    const prompts: string[] = [];
    const service = new OrchestratorTaskService(
      runtime(acp, async (_modelType, params) => {
        prompts.push((params as { prompt: string }).prompt);
        // Pass so the path completes without re-prompting the worker.
        return '{"passed": true, "summary": "ok", "missing": []}';
      }),
      { store: new OrchestratorTaskStore({ backend: "memory" }) },
    );
    await service.start();

    const task = await service.createTask({
      title: "Cache the search endpoint",
      goal: "Add caching to /search",
      acceptanceCriteria: ["the search endpoint is cached", "tests pass"],
    });
    const detail = await service.spawnAgentForTask(task.id);
    const sessionId = detail?.sessions[0]?.sessionId;
    if (!sessionId) throw new Error("expected a spawned session");

    // The router mirrors a real change set onto the live ACP session at
    // completion; stand that in so the evidence assembler reads it.
    acp.setSessionMetadata(sessionId, { lastChangeSet: changeSet() });

    // Recorded sub-agent output carrying a build/test line for the miner.
    await service.addMessage(task.id, {
      content:
        "Ran the suite: Tests  8 passed (8). Live at https://app.example.com",
      senderKind: "sub_agent",
      sessionId,
      direction: "stdout",
    });

    acp.emit(sessionId, "task_complete", {
      response: "Added caching and verified it works.",
    });
    await waitForPrompt(prompts);

    expect(prompts).toHaveLength(1);
    const [prompt] = prompts;

    // The verifier saw the assembled SECTIONED evidence, not just the summary.
    expect(prompt).toContain("## CHANGESET");
    expect(prompt).toContain("1 file changed, 20 insertions(+)");
    expect(prompt).toContain("src/cache.ts");
    expect(prompt).toContain("## FINAL REPLY");
    expect(prompt).toContain("Added caching and verified it works.");
    expect(prompt).toContain("## TEST / BUILD / TYPECHECK OUTPUT");
    expect(prompt).toContain("Tests  8 passed (8)");
    // The URL is only MENTIONED in the sub-agent's stdout (no router probe ran),
    // so it is surfaced as an unproven claim — never as a probe-verified deploy.
    expect(prompt).toContain("## CLAIMED URLS");
    expect(prompt).toContain("https://app.example.com");
    expect(prompt).not.toContain("## VERIFIED URLS");
  });

  it("falls back to the bare summary when no richer evidence exists", async () => {
    const acp = new EvidenceFakeAcp();
    const prompts: string[] = [];
    const service = new OrchestratorTaskService(
      runtime(acp, async (_modelType, params) => {
        prompts.push((params as { prompt: string }).prompt);
        return '{"passed": true, "summary": "ok", "missing": []}';
      }),
      { store: new OrchestratorTaskStore({ backend: "memory" }) },
    );
    await service.start();

    const task = await service.createTask({
      title: "Trivial",
      goal: "Do the thing",
      acceptanceCriteria: ["the thing is done"],
    });
    const detail = await service.spawnAgentForTask(task.id);
    const sessionId = detail?.sessions[0]?.sessionId;
    if (!sessionId) throw new Error("expected a spawned session");

    acp.emit(sessionId, "task_complete", {
      response: "the thing is done now",
    });
    await waitForPrompt(prompts);

    expect(prompts).toHaveLength(1);
    const [prompt] = prompts;
    // No CHANGESET / TEST section header — but the summary still reaches the
    // verifier (here as the FINAL REPLY body, the only available signal).
    expect(prompt).not.toContain("## CHANGESET");
    expect(prompt).not.toContain("## TEST / BUILD / TYPECHECK OUTPUT");
    expect(prompt).toContain("the thing is done now");
  });
});
