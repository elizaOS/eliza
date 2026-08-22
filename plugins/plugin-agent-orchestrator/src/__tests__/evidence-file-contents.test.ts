/**
 * The judge sees each verified deliverable file's real text — for a ledger
 * adapter too, not only the ledger-less recovery path. With only the 3 KB
 * diff excerpt, a served 123-line page failed three laps for "the truncated
 * diff hides the JavaScript" (live 2026-08-22). Real service + memory store.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../services/orchestrator-task-store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("completion evidence file contents", () => {
  it("includes the ledger-verified deliverable's full text", async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-"));
    dirs.push(workdir);
    const html = `<!DOCTYPE html><html><body><textarea id="t"></textarea>\n<script>\n${"// logic line\n".repeat(300)}document.getElementById("t").addEventListener("input", () => {});\n</script></body></html>`;
    fs.writeFileSync(path.join(workdir, "index.html"), html);
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const runtime = {
      character: { name: "Tester" },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      getSetting: () => undefined,
      getService: () => undefined,
    };
    const service = new OrchestratorTaskService(runtime as never, { store });
    const detail = await store.createTask({ title: "page", goal: "a page" });
    const taskId = detail.task.id;
    const now = Date.now();
    await store.addSession({
      id: "row-s1",
      taskId,
      sessionId: "s1",
      framework: "eliza-code",
      label: "page",
      originalTask: "Build a page",
      workdir,
      status: "completed",
      decisionCount: 0,
      autoResolvedCount: 0,
      registeredAt: now - 10_000,
      lastActivityAt: now,
      idleCheckCount: 0,
      taskDelivered: true,
      lastSeenDecisionIndex: 0,
      spawnedAt: now - 10_000,
      retryCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheTokens: 0,
      costUsd: 0,
      usageState: "unavailable",
      metadata: {
        lastChangeSet: {
          changedFiles: ["index.html"],
          capturedAt: now,
          diffStat: " index.html | 305 +",
          diff: `diff --git a/index.html b/index.html\n+${html.slice(0, 200)}`,
        },
      },
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    });
    await store.addEvent({
      id: "ev-1",
      taskId,
      sessionId: "s1",
      eventType: "tool_running",
      summary: "Running FILE write index.html",
      data: {
        toolCall: {
          id: "call-1",
          kind: "write",
          status: "completed",
          rawInput: { path: "index.html", content: html },
        },
      },
      timestamp: now,
      createdAt: new Date(now).toISOString(),
    });
    const bundle = await (
      service as unknown as {
        collectEvidenceBundle: (
          t: string,
          s: string,
          f: string,
        ) => Promise<{
          ledgerVerifiedFiles?: string[];
          fsVerifiedFileContents?: Array<{ path: string; content: string }>;
        }>;
      }
    ).collectEvidenceBundle(taskId, "s1", "done");
    expect(bundle.ledgerVerifiedFiles).toEqual(["index.html"]);
    const entry = bundle.fsVerifiedFileContents?.find(
      (e) => e.path === "index.html",
    );
    expect(entry).toBeDefined();
    expect(entry?.content).toContain('addEventListener("input"');
  });
});
