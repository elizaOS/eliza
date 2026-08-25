/**
 * Curated coding-memory tests cover the safety contract around verified-task
 * harvest, bounded note persistence, and repo/tenant-scoped retrieval.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CuratedCodingMemoryService,
  curatedCodingMemoryPath,
  harvestCodingMemoryCandidates,
  redactCodingMemoryText,
} from "../services/curated-coding-memory.js";
import type { OrchestratorTaskDocument } from "../services/orchestrator-task-types.js";

function runtime(
  agentId: string,
  settings: Record<string, unknown> = {},
): Parameters<typeof harvestCodingMemoryCandidates>[1] {
  return {
    agentId,
    getSetting: (key: string) => settings[key],
    getService: () => null,
    reportError: () => undefined,
    logger: { warn: () => undefined, info: () => undefined },
  } as unknown as Parameters<typeof harvestCodingMemoryCandidates>[1];
}

function doc(input: {
  workdir: string;
  status?: OrchestratorTaskDocument["task"]["status"];
  groundTruthStatus?: string;
  text?: string;
  taskId?: string;
  senderKind?: "user" | "orchestrator" | "sub_agent" | "system";
  direction?: "stdout" | "stderr" | "stdin" | "keys" | "system";
}): OrchestratorTaskDocument {
  const taskId = input.taskId ?? "task-1";
  return {
    task: {
      id: taskId,
      title: "Implement feature",
      goal: "Implement feature",
      kind: "coding",
      status: input.status ?? "done",
      priority: "normal",
      originalRequest: "Implement feature",
      acceptanceCriteria: ["criteria"],
      paused: false,
      archived: false,
      boundWorkdir: input.workdir,
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
      lastActivityAt: 1,
      metadata: {
        groundTruthVerdict: {
          status: input.groundTruthStatus ?? "verified",
          checkedAt: "2026-07-17T00:00:00.000Z",
          pr: {
            claimed: true,
            url: "https://github.com/elizaOS/eliza/pull/16443",
            repo: "elizaOS/eliza",
            number: 16443,
            exists: true,
            state: "open",
            headSha: "abc123",
          },
          checks: { state: "green", items: [] },
          files: {
            claimed: [],
            actual: [],
            changedButNotClaimed: [],
            claimedButNotChanged: [],
          },
          hardFail: false,
          hardFailReasons: [],
          summary: "verified",
        },
      },
    },
    sessions: [
      {
        id: "session-row-1",
        taskId,
        sessionId: "session-1",
        framework: "codex",
        label: "Codex",
        originalTask: "Implement feature",
        workdir: input.workdir,
        repo: "elizaOS/eliza",
        status: "completed",
        decisionCount: 0,
        autoResolvedCount: 0,
        registeredAt: 1,
        lastActivityAt: 1,
        idleCheckCount: 0,
        taskDelivered: true,
        lastSeenDecisionIndex: 0,
        spawnedAt: 1,
        retryCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheTokens: 0,
        costUsd: 0,
        usageState: "unavailable",
        metadata: {},
        createdAt: "2026-07-17T00:00:00.000Z",
        updatedAt: "2026-07-17T00:00:00.000Z",
      },
    ],
    messages: [
      {
        id: "message-1",
        taskId,
        sessionId: "session-1",
        senderKind: input.senderKind ?? "sub_agent",
        direction: input.direction ?? "stdout",
        content:
          input.text ??
          "Lesson: Keep orchestrator memory notes reviewable and bounded.",
        searchableText: input.text ?? "",
        timestamp: 1,
        metadata: {},
        createdAt: "2026-07-17T00:00:00.000Z",
      },
    ],
    events: [],
    usage: [],
    artifacts: [],
    decisions: [],
    planRevisions: [],
  };
}

async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "curated-coding-memory-"));
}

function memoryRuntime(
  workdir: string,
  agentId = "tenant-a",
  settings: Record<string, unknown> = {},
): ReturnType<typeof runtime> {
  return runtime(agentId, {
    ELIZA_CURATED_CODING_MEMORY_DIR: workdir,
    ...settings,
  });
}

function memoryPath(workdir: string, agentId = "tenant-a"): string {
  return curatedCodingMemoryPath(
    memoryRuntime(workdir, agentId),
    "elizaOS/eliza",
  );
}

describe("curated coding memory", () => {
  it("harvests only verified completed task candidates", async () => {
    const workdir = await tempWorkspace();
    try {
      expect(
        harvestCodingMemoryCandidates(doc({ workdir }), runtime("a")),
      ).toHaveLength(1);
      expect(
        harvestCodingMemoryCandidates(
          doc({ workdir, status: "validating" }),
          runtime("a"),
        ),
      ).toHaveLength(0);
      expect(
        harvestCodingMemoryCandidates(
          doc({ workdir, groundTruthStatus: "inconclusive" }),
          runtime("a"),
        ),
      ).toHaveLength(0);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("accepts explicit user decisions but not worker-claimed decisions or raw stderr", () => {
    const workdir = "/tmp/curated-memory-source-test";
    expect(
      harvestCodingMemoryCandidates(
        doc({
          workdir,
          text: "Decision: Keep the public interface stable.",
          senderKind: "sub_agent",
        }),
        runtime("a"),
      ),
    ).toHaveLength(0);
    expect(
      harvestCodingMemoryCandidates(
        doc({
          workdir,
          text: "Decision: Keep the public interface stable.",
          senderKind: "user",
        }),
        runtime("a"),
      ),
    ).toHaveLength(1);
    expect(
      harvestCodingMemoryCandidates(
        doc({
          workdir,
          text: "Reviewer finding: worker self-endorsed this change.",
          senderKind: "sub_agent",
        }),
        runtime("a"),
      ),
    ).toHaveLength(0);
    expect(
      harvestCodingMemoryCandidates(
        doc({
          workdir,
          text: "Lesson: printed by an untrusted tool",
          direction: "stderr",
        }),
        runtime("a"),
      ),
    ).toHaveLength(0);
  });

  it("redacts secrets, credentials, and personal data", () => {
    // Construct inert fixtures at runtime so secret scanners do not mistake
    // the test vectors for committed credentials.
    const githubFixture = ["gh", "p_123456789012345678901234"].join("");
    const apiFixture = ["s", "k-123456789012345678901234567890"].join("");
    expect(
      redactCodingMemoryText(
        `Decision: token=${githubFixture} and email dev@example.com`,
      ),
    ).not.toContain(githubFixture);
    expect(redactCodingMemoryText(`apiKey=${apiFixture}`)).toContain(
      "[REDACTED]",
    );
  });

  it("redacts token formats the retired local denylist missed", () => {
    // Fixtures assembled at runtime so secret scanners do not flag them.
    // Each row defeated the previous hand-maintained pattern list; the notes
    // file is injected as coding context, so a miss here is a live credential
    // handed to a future sub-agent. See issue #23419.
    const cases: Array<[string, string]> = [
      ["stripe live", ["sk", "_live_51H8xQ2LmNpQrStUv"].join("")],
      [
        "github fine-grained pat",
        ["github", "_pat_11ABCDE0Y0aBcDeFgHiJkLmNoPqRsTuVwXyZ012345"].join(""),
      ],
      [
        "slack app token",
        ["xapp", "-1-A01B2C3D4-1234567890-abcdefabcdef"].join(""),
      ],
    ];
    for (const [label, fixture] of cases) {
      const redacted = redactCodingMemoryText(`Decision: used ${fixture} here`);
      expect(redacted, label).not.toContain(fixture);
    }
  });

  it("redacts a quoted credential inside a serialized provider error body", () => {
    // The shape a provider error `detail` actually carries. The retired
    // pattern's value class excluded quotes, so it matched nothing at all.
    const fixture = ["sk", "_live_9ZyXwVuTsRqPoNmL"].join("");
    const body = JSON.stringify({ error: "auth_failed", api_key: fixture });
    expect(redactCodingMemoryText(body)).not.toContain(fixture);
  });

  it("does not maintain a local credential pattern list", async () => {
    // Structural: a second hand-maintained denylist is how this drifted in the
    // first place. Credential shapes must come from the canonical core set.
    const source = await readFile(
      join(import.meta.dirname, "../services/curated-coding-memory.ts"),
      "utf8",
    );
    expect(source).toContain("getDefaultRedactPatterns");
  });

  it("dedupes similar notes and merges provenance", async () => {
    const workdir = await tempWorkspace();
    try {
      const service = new CuratedCodingMemoryService(memoryRuntime(workdir));
      await service.harvestVerifiedTask(
        doc({
          workdir,
          taskId: "task-1",
          text: "Lesson: Keep orchestrator memory notes reviewable and bounded.",
        }),
      );
      await service.harvestVerifiedTask(
        doc({
          workdir,
          taskId: "task-2",
          text: "Lesson: Keep orchestrator memory notes reviewable and bounded!",
        }),
      );
      const file = await readFile(memoryPath(workdir), "utf8");
      expect(file.match(/### note:/g)).toHaveLength(1);
      expect(file).toContain("task:task-1");
      expect(file).toContain("task:task-2");
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("retains every harvested note", async () => {
    const workdir = await tempWorkspace();
    try {
      const service = new CuratedCodingMemoryService(
        memoryRuntime(workdir, "tenant-a"),
      );
      await service.harvestVerifiedTask(
        doc({
          workdir,
          taskId: "task-1",
          text: "Lesson: Alpha module uses typed errors.",
        }),
      );
      await service.harvestVerifiedTask(
        doc({
          workdir,
          taskId: "task-2",
          text: "Decision: Beta module keeps public interfaces stable.",
          senderKind: "user",
        }),
      );
      await service.harvestVerifiedTask(
        doc({
          workdir,
          taskId: "task-3",
          text: "Reviewer finding: Gamma route needs explicit error state.",
          senderKind: "orchestrator",
        }),
      );
      const file = await readFile(memoryPath(workdir), "utf8");
      expect(file.match(/### note:/g)).toHaveLength(3);
      expect(file).toContain("Alpha module");
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent atomic writes", async () => {
    const workdir = await tempWorkspace();
    try {
      const service = new CuratedCodingMemoryService(memoryRuntime(workdir));
      await Promise.all([
        service.harvestVerifiedTask(
          doc({
            workdir,
            taskId: "task-1",
            text: "Lesson: Alpha concurrency writes use locks.",
          }),
        ),
        service.harvestVerifiedTask(
          doc({
            workdir,
            taskId: "task-2",
            text: "Decision: Beta concurrency writes use atomic rename.",
            senderKind: "user",
          }),
        ),
        service.harvestVerifiedTask(
          doc({
            workdir,
            taskId: "task-3",
            text: "Reviewer finding: Gamma concurrency keeps all notes.",
            senderKind: "orchestrator",
          }),
        ),
      ]);
      const file = await readFile(memoryPath(workdir), "utf8");
      expect(file).toContain("Alpha concurrency");
      expect(file).toContain("Beta concurrency");
      expect(file).toContain("Gamma concurrency");
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("honors disabled policy", async () => {
    const workdir = await tempWorkspace();
    try {
      const service = new CuratedCodingMemoryService(
        memoryRuntime(workdir, "tenant-a", {
          ELIZA_CURATED_CODING_MEMORY: "0",
        }),
      );
      await service.harvestVerifiedTask(doc({ workdir }));
      await expect(readFile(memoryPath(workdir), "utf8")).rejects.toMatchObject(
        { code: "ENOENT" },
      );
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("retrieves every relevant note without a token budget", async () => {
    const workdir = await tempWorkspace();
    try {
      const service = new CuratedCodingMemoryService(
        memoryRuntime(workdir, "tenant-a"),
      );
      await service.harvestVerifiedTask(
        doc({
          workdir,
          taskId: "task-1",
          text: "Lesson: `MemoryProvider` must filter by tenant.",
        }),
      );
      await service.harvestVerifiedTask(
        doc({
          workdir,
          taskId: "task-2",
          text: "Decision: Tenant memory provider retrieval stays bounded.",
          senderKind: "user",
        }),
      );
      const notes = await service.retrieveRelevant({
        text: "How should MemoryProvider filter tenant memory?",
        repoKey: "https://github.com/elizaOS/eliza.git",
      });
      expect(notes).toHaveLength(2);
      expect(notes.map((note) => note.text).join("\n")).toContain(
        "MemoryProvider",
      );
      expect(notes.map((note) => note.text).join("\n")).toContain(
        "retrieval stays bounded",
      );
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("re-redacts manually edited notes before prompt retrieval", async () => {
    const workdir = await tempWorkspace();
    try {
      const service = new CuratedCodingMemoryService(memoryRuntime(workdir));
      await service.harvestVerifiedTask(
        doc({ workdir, text: "Lesson: EntityStore relationships stay typed." }),
      );
      const path = memoryPath(workdir);
      const fixture = ["s", "k-123456789012345678901234567890"].join("");
      const edited = (await readFile(path, "utf8")).replace(
        "EntityStore relationships stay typed.",
        `EntityStore relationships token=${fixture}`,
      );
      await writeFile(path, edited, "utf8");
      const notes = await service.retrieveRelevant({
        text: "EntityStore relationships",
        repoKey: "elizaOS/eliza",
      });
      expect(notes).toHaveLength(1);
      expect(notes[0]?.text).not.toContain(fixture);
      expect(notes[0]?.text).toContain("[REDACTED]");
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("rejects notes from a different bound repository", async () => {
    const workdir = await tempWorkspace();
    try {
      const service = new CuratedCodingMemoryService(memoryRuntime(workdir));
      await service.harvestVerifiedTask(
        doc({ workdir, text: "Lesson: Repo memory remains isolated." }),
      );
      const notes = await service.retrieveRelevant({
        text: "repo memory isolated",
        repoKey: "another-owner/another-repo",
      });
      expect(notes).toHaveLength(0);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("isolates retrieval by tenant", async () => {
    const workdir = await tempWorkspace();
    try {
      await new CuratedCodingMemoryService(
        memoryRuntime(workdir, "tenant-a"),
      ).harvestVerifiedTask(
        doc({ workdir, text: "Lesson: Tenant A memory must not leak." }),
      );
      const notes = await new CuratedCodingMemoryService(
        memoryRuntime(workdir, "tenant-b"),
      ).retrieveRelevant({
        text: "tenant memory leak",
        repoKey: "elizaOS/eliza",
      });
      expect(notes).toHaveLength(0);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("ranks relevant notes deterministically by match score", async () => {
    const workdir = await tempWorkspace();
    try {
      const service = new CuratedCodingMemoryService(memoryRuntime(workdir));
      await service.harvestVerifiedTask(
        doc({
          taskId: "task-1",
          workdir,
          text: "Lesson: Always run verification gates before PR creation.",
        }),
      );
      await service.harvestVerifiedTask(
        doc({
          taskId: "task-2",
          workdir,
          text: "Lesson: Run verification gates and check audit logs carefully.",
        }),
      );
      const notes = await service.retrieveRelevant({
        text: "verification gates PR creation",
        repoKey: "elizaOS/eliza",
      });
      expect(notes.length).toBeGreaterThan(0);
      expect(notes[0]?.text).toContain("verification gates before PR creation");
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });
});
