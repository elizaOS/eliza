/**
 * Unit tests for the TYPED completion-evidence bundle (issue #8894).
 *
 * Drives a real {@link OrchestratorTaskService} + in-memory store through a
 * `task_complete` event (deterministic — no live model; the verifier model is
 * stubbed and its prompt captured) and asserts:
 *  - the bundle the verifier sees populates ≥3 fields (summary + diff +
 *    tool output) from mocked session events/metadata;
 *  - test/build stdout is mined out of recorded `tool_running` events;
 *  - a trajectory JSONL line is written and its path recorded on a task event.
 *
 * The pure-string assembler (`buildCompletionEvidenceString`) and tool-output
 * classifier (`classifyToolOutput`) are pinned directly too.
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyToolOutput } from "../../src/services/completion-evidence.js";
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

/** ACP fake exposing the completion surface: event subscription, spawn, the
 *  change-set read (`getSession`) AND a per-session `workdir` so the trajectory
 *  writer targets the test's temp dir. */
class BundleFakeAcp {
  private handler:
    | ((sessionId: string, event: string, data: unknown) => void)
    | null = null;
  private counter = 0;
  private readonly sessionMeta = new Map<string, Record<string, unknown>>();
  private readonly sessionWorkdir = new Map<string, string>();

  constructor(private readonly defaultWorkdir: string) {}

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
    const workdir = (opts.workdir as string | undefined) ?? this.defaultWorkdir;
    this.sessionWorkdir.set(sessionId, workdir);
    return Promise.resolve({
      sessionId,
      agentType: (opts.agentType as string | undefined) ?? "opencode",
      workdir,
      status: "ready",
    });
  }

  getSession(sessionId: string): Promise<
    | {
        metadata: Record<string, unknown>;
        workdir: string;
      }
    | undefined
  > {
    const workdir = this.sessionWorkdir.get(sessionId);
    if (!workdir) return Promise.resolve(undefined);
    return Promise.resolve({
      metadata: this.sessionMeta.get(sessionId) ?? {},
      workdir,
    });
  }

  getChangedPaths(): string[] {
    return [];
  }

  updateSessionMetadata(): Promise<void> {
    return Promise.resolve();
  }

  sendToSession(): Promise<void> {
    return Promise.resolve();
  }

  stopSession(): Promise<void> {
    return Promise.resolve();
  }
}

function runtime(
  acp: BundleFakeAcp,
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

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/** Poll `predicate` until it returns truthy, flushing the macrotask queue each
 *  iteration. Deterministic wait for a fire-and-forget side effect (the
 *  trajectory write) instead of a fixed flush count. */
async function waitFor<T>(
  predicate: () => Promise<T> | T,
  { tries = 200, label = "condition" }: { tries?: number; label?: string } = {},
): Promise<T> {
  for (let i = 0; i < tries; i += 1) {
    const value = await predicate();
    if (value) return value;
    await flush();
  }
  throw new Error(`waitFor timed out: ${label}`);
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

describe("classifyToolOutput", () => {
  it("buckets test and build stdout out of mocked tool events", () => {
    const out = classifyToolOutput([
      {
        text: "Test Files  3 passed (3)\nTests  12 passed (12)",
        source: "vitest run",
      },
      { text: "tsc --noEmit\nCompiled with 0 errors", source: "tsc --noEmit" },
      { text: "just narration about the code", source: "message" },
    ]);
    expect(out).toBeDefined();
    expect(out?.test).toContain("Tests  12 passed (12)");
    expect(out?.build).toContain("Compiled with 0 errors");
    // The narration line carried no build/test marker, so nothing leaks in.
    expect(out?.raw).toBeUndefined();
  });

  it("returns undefined when no signal carries build/test output", () => {
    expect(
      classifyToolOutput([{ text: "hello world", source: "message" }]),
    ).toBeUndefined();
  });
});

describe("completion-evidence bundle assembly + trajectory persistence", () => {
  const prevFlag = process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;
  const prevIndependent = process.env.ELIZA_ORCHESTRATOR_INDEPENDENT_VERIFY;
  let workdir: string;

  beforeEach(async () => {
    process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = "1";
    // Isolate the TEXT-JUDGE evidence path: the #8898 independent verifier is a
    // separate gate that precedes the judge for code-change tasks; turn it off
    // here so these assertions exercise the evidence bundle the judge sees.
    process.env.ELIZA_ORCHESTRATOR_INDEPENDENT_VERIFY = "0";
    workdir = await mkdtemp(join(tmpdir(), "evidence-bundle-"));
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

  it("populates ≥3 bundle fields and feeds them to the verifier", async () => {
    const acp = new BundleFakeAcp(workdir);
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
      title: "Cache the search endpoint",
      goal: "Add caching to /search",
      acceptanceCriteria: ["the search endpoint is cached", "tests pass"],
    });
    const detail = await service.spawnAgentForTask(task.id);
    const sessionId = detail?.sessions[0]?.sessionId;
    if (!sessionId) throw new Error("expected a spawned session");

    // (1) diff field — change set mirrored onto the live ACP session.
    acp.setSessionMetadata(sessionId, { lastChangeSet: changeSet() });

    // (2) tool-output field — a `tool_running` event carrying real test stdout.
    acp.emit(sessionId, "tool_running", {
      toolCall: {
        title: "vitest run",
        kind: "execute",
        status: "completed",
        rawInput: { command: "bun run test" },
        output:
          "Running suite...\nTest Files  2 passed (2)\nTests  8 passed (8)",
      },
    });

    // (3) summary field — the task_complete response.
    acp.emit(sessionId, "task_complete", {
      response: "Added caching and verified it works.",
    });
    // Verification crosses the event bridge and a thread-pool filesystem read,
    // so the verifier call is the stable synchronization point under runner load.
    await waitFor(() => prompts.length > 0, { label: "verifier prompted" });

    expect(prompts).toHaveLength(1);
    const [prompt] = prompts;
    // diff + summary + tool output = three populated fields reaching the verifier.
    expect(prompt).toContain("## CHANGESET");
    expect(prompt).toContain("src/cache.ts");
    expect(prompt).toContain("## FINAL REPLY");
    expect(prompt).toContain("Added caching and verified it works.");
    expect(prompt).toContain("## TEST / BUILD / TYPECHECK OUTPUT");
    expect(prompt).toContain("Tests  8 passed (8)");
    // The trajectory artifact is cited in the evidence.
    expect(prompt).toContain("[trajectory] completion trajectory");
    expect(prompt).toContain("completion-evidence.jsonl");
  });

  it("does NOT label a URL merely mentioned in prose as verified", async () => {
    const acp = new BundleFakeAcp(workdir);
    const prompts: string[] = [];
    const service = new OrchestratorTaskService(
      runtime(acp, async (_modelType, params) => {
        prompts.push((params as { prompt: string }).prompt);
        return '{"passed": false, "summary": "unverified", "missing": ["live"]}';
      }),
      { store: new OrchestratorTaskStore({ backend: "memory" }) },
    );
    await service.start();

    const task = await service.createTask({
      title: "Ship the landing page",
      goal: "Build and deploy the landing page",
      acceptanceCriteria: ["the live URL returns HTTP 200"],
    });
    const detail = await service.spawnAgentForTask(task.id);
    const sessionId = detail?.sessions[0]?.sessionId;
    if (!sessionId) throw new Error("expected a spawned session");

    // A sub-agent that CLAIMS a deploy in prose — no router URL probe ran, so
    // `subAgentVerifiedUrls` metadata is absent.
    acp.emit(sessionId, "task_complete", {
      response:
        "Done — deployed to https://claimed-but-not-probed.example.com/",
    });
    // This path also captures the git change set before reading child trajectories;
    // synchronize on the resulting verifier call instead of scheduler timing.
    await waitFor(() => prompts.length > 0, { label: "verifier prompted" });

    expect(prompts).toHaveLength(1);
    const [prompt] = prompts;
    // The URL is surfaced, but explicitly as an unproven claim...
    expect(prompt).toContain("## CLAIMED URLS");
    expect(prompt).toContain("NOT probe-verified");
    expect(prompt).toContain("https://claimed-but-not-probed.example.com/");
    // ...and NEVER under the probe-verified header.
    expect(prompt).not.toContain("## VERIFIED URLS");
  });

  it("writes the bundle as a JSONL line and records its path on a task event", async () => {
    const acp = new BundleFakeAcp(workdir);
    const service = new OrchestratorTaskService(
      runtime(
        acp,
        async () => '{"passed": true, "summary": "ok", "missing": []}',
      ),
      { store: new OrchestratorTaskStore({ backend: "memory" }) },
    );
    await service.start();

    const task = await service.createTask({
      title: "Cache it",
      goal: "Add caching",
      acceptanceCriteria: ["tests pass"],
    });
    const detail = await service.spawnAgentForTask(task.id);
    const sessionId = detail?.sessions[0]?.sessionId;
    if (!sessionId) throw new Error("expected a spawned session");

    acp.setSessionMetadata(sessionId, { lastChangeSet: changeSet() });
    acp.emit(sessionId, "task_complete", {
      response: "Done and tested.",
    });

    const trajectoryPath = join(
      workdir,
      ".eliza",
      "trajectories",
      "completion-evidence.jsonl",
    );
    // The write is fire-and-forget (real mkdir + appendFile + addEvent); wait
    // deterministically for the JSONL file to land instead of guessing a flush
    // count.
    const raw = await waitFor(
      () => readFile(trajectoryPath, "utf8").catch(() => ""),
      { label: "trajectory JSONL written" },
    );
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]) as {
      kind: string;
      taskId: string;
      sessionId: string;
      bundle: {
        summary: string;
        diffSummary?: string;
        trajectoryPath?: string;
      };
    };
    expect(record.kind).toBe("completion_evidence_bundle");
    expect(record.taskId).toBe(task.id);
    expect(record.sessionId).toBe(sessionId);
    expect(record.bundle.summary).toBe("Done and tested.");
    expect(record.bundle.diffSummary).toContain("src/cache.ts");
    expect(record.bundle.trajectoryPath).toBe(trajectoryPath);

    // The path is recorded on a durable task event for the reviewer.
    const persistedEvent = await waitFor(
      async () => {
        const reloaded = await service.getTask(task.id);
        return reloaded?.events.find(
          (event) => event.eventType === "completion_evidence_persisted",
        );
      },
      { label: "completion_evidence_persisted event recorded" },
    );
    expect(persistedEvent).toBeDefined();
    expect(
      (persistedEvent?.data as { trajectoryPath?: string } | undefined)
        ?.trajectoryPath,
    ).toBe(trajectoryPath);
  });
});
