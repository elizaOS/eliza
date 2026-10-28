/**
 * Completion evidence for a session that edits files already dirty or
 * untracked when it spawned, through a PGlite-backed AgentRuntime, the ACP
 * tool-call path and a real Git repository. captureChangeSet keeps those
 * files because the session wrote them, so the verifier's CHANGESET must keep
 * them too, while baseline files the session never wrote stay out.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime, IAgentRuntime, ServiceClass } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AcpService } from "../services/acp-service.js";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
import {
  captureBaselineDirty,
  captureBaselineSha,
  captureBaselineUntracked,
  captureChangeSet,
} from "../services/workspace-diff.js";
import { createRealTestRuntime } from "./real-runtime.js";

/** The production ACP service with its in-memory session store. start() would
 *  reconcile host scratch directories and arm the health check; this test
 *  only needs the tool-call path. */
class UnstartedAcpService extends AcpService {
  static override async start(runtime: IAgentRuntime): Promise<AcpService> {
    return new UnstartedAcpService(runtime);
  }
}

describe("completion evidence for baseline files the session wrote", () => {
  let runtime: AgentRuntime;
  let cleanupRuntime: (() => Promise<void>) | undefined;
  let acp: AcpService;
  let service: OrchestratorTaskService;
  let root: string;
  let workdir: string;
  const previousStateDir = process.env.ELIZA_STATE_DIR;

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: workdir, encoding: "utf8" });

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "baseline-evidence-"));
    workdir = join(root, "work");
    // The evidence trajectory is written under the state directory.
    process.env.ELIZA_STATE_DIR = join(root, "state");
    ({ runtime, cleanup: cleanupRuntime } = await createRealTestRuntime({
      characterName: "OrchestratorBaselineEvidenceTest",
      plugins: [
        {
          name: "orchestrator-baseline-evidence-test",
          description: "Registers the production ACP and task services",
          services: [
            UnstartedAcpService as unknown as ServiceClass,
            OrchestratorTaskService as unknown as ServiceClass,
          ],
        },
      ],
    }));
    const loadedAcp = await runtime.getServiceLoadPromise(
      AcpService.serviceType,
    );
    const loadedService = await runtime.getServiceLoadPromise(
      OrchestratorTaskService.serviceType,
    );
    if (
      !(loadedAcp instanceof AcpService) ||
      !(loadedService instanceof OrchestratorTaskService)
    ) {
      throw new Error("Production ACP or orchestrator task service missing");
    }
    acp = loadedAcp;
    service = loadedService;

    mkdirSync(workdir);
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("config", "commit.gpgsign", "false");
    mkdirSync(join(workdir, "src"));
    mkdirSync(join(workdir, "docs"));
    writeFileSync(join(workdir, "src", "app.ts"), "export const v = 1;\n");
    writeFileSync(join(workdir, "docs", "notes.md"), "# Notes\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
  }, 60_000);

  afterAll(async () => {
    await cleanupRuntime?.();
    if (previousStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
    else process.env.ELIZA_STATE_DIR = previousStateDir;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function recordToolWrite(sessionId: string, callId: string, path: string) {
    acp["handleAcpEvent"](
      {
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: callId,
            kind: "edit",
            status: "completed",
            rawInput: { file_path: join(workdir, path) },
          },
        },
      },
      sessionId,
      "",
      Date.now(),
      false,
      new Set(),
    );
  }

  it("keeps a dirty or untracked spawn file the session edited in the CHANGESET", async () => {
    // Before spawn: the user's uncommitted edit to src/app.ts and to
    // docs/notes.md, a new file left by an earlier attempt, and scratch.
    writeFileSync(join(workdir, "src", "app.ts"), "export const v = 2;\n");
    writeFileSync(join(workdir, "docs", "notes.md"), "# Notes\nWIP\n");
    writeFileSync(join(workdir, "src", "draft.ts"), "export const d = 0;\n");
    writeFileSync(join(workdir, "scratch.txt"), "scratch\n");
    const codingBaselineSha = await captureBaselineSha(workdir);
    const codingBaselineDirty = await captureBaselineDirty(workdir);
    const codingBaselineUntracked = await captureBaselineUntracked(workdir);
    expect(codingBaselineDirty).toEqual(["docs/notes.md", "src/app.ts"]);
    expect(codingBaselineUntracked).toEqual(["scratch.txt", "src/draft.ts"]);

    // The session edits src/app.ts and src/draft.ts with its edit tool, then
    // commits everything from the shell.
    const sessionId = "baseline-writer";
    writeFileSync(
      join(workdir, "src", "app.ts"),
      "export const v = 2;\nexport function validate() {}\n",
    );
    recordToolWrite(sessionId, "edit-app", "src/app.ts");
    writeFileSync(
      join(workdir, "src", "draft.ts"),
      "export const d = 0;\nexport function draftReady() {}\n",
    );
    recordToolWrite(sessionId, "edit-draft", "src/draft.ts");
    git("add", "-A");
    git("commit", "-q", "-m", "add validate");

    // The task_complete capture in sub-agent-router.
    const lastChangeSet = await captureChangeSet(
      workdir,
      codingBaselineSha,
      acp.getChangedPaths(sessionId),
      codingBaselineDirty,
    );
    expect(lastChangeSet?.changedFiles).toEqual([
      "src/app.ts",
      "src/draft.ts",
      "scratch.txt",
    ]);

    const task = await service.createTask({
      title: "Add validate",
      goal: "Add a validate() export to src/app.ts",
      acceptanceCriteria: ["git diff shows validate() in src/app.ts"],
    });
    const attached = await service.attachSession(task.id, {
      sessionId,
      agentType: "codex",
      workdir,
      status: "ready",
      metadata: {
        codingBaselineSha,
        codingBaselineDirty,
        codingBaselineUntracked,
        lastChangeSet,
      },
    });
    expect(attached).toBe(true);

    const { evidence, bundle } = await service["buildCompletionEvidence"](
      task.id,
      sessionId,
      "Added validate() to src/app.ts",
    );
    expect(evidence).toContain("## CHANGESET");
    expect(bundle?.diffSummary).toContain("+export function validate() {}");
    expect(bundle?.diffSummary).toContain("+export function draftReady() {}");
    // Baseline files the session never wrote stay out of the evidence.
    expect(bundle?.diffSummary).not.toContain("docs/notes.md");
    expect(bundle?.diffSummary).not.toContain("scratch.txt");
  });
});
