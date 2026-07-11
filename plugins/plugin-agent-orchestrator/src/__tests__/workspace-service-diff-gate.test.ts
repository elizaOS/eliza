/** Verifies the create-PR boundary fails closed before calling the GitHub finalizer. */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

const { capturePrGateChangeSet } = vi.hoisted(() => ({
  capturePrGateChangeSet: vi.fn(),
}));
vi.mock("../services/workspace-diff.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/workspace-diff.js")>();
  return { ...actual, capturePrGateChangeSet };
});
vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  class TestElizaError extends Error {
    readonly code: string;
    readonly context?: Record<string, unknown>;
    readonly severity?: string;

    constructor(
      message: string,
      options: {
        code: string;
        cause?: unknown;
        context?: Record<string, unknown>;
        severity?: string;
      },
    ) {
      super(
        message,
        options.cause !== undefined ? { cause: options.cause } : undefined,
      );
      this.name = "ElizaError";
      this.code = options.code;
      this.context = options.context;
      this.severity = options.severity;
      Object.setPrototypeOf(this, new.target.prototype);
    }
  }
  return { ...actual, ElizaError: TestElizaError };
});

import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CodingWorkspaceService,
  DiffGateBlockedError,
} from "../services/workspace-service.js";

const workspace = {
  id: "execution-1",
  path: "/tmp/gate-workspace",
  branch: "feature",
  baseBranch: "main",
  isWorktree: false,
  repo: "https://github.com/example/repo.git",
  status: "ready",
};

const roots: string[] = [];

function harness() {
  const reportError = vi.fn();
  const runtime = {
    getSetting: vi.fn(() => undefined),
    reportError,
  } as unknown as IAgentRuntime;
  const service = new CodingWorkspaceService(runtime, {
    baseDir: tmpRoot("workspace-service-base-"),
  });
  const finalize = vi.fn(async () => ({
    number: 42,
    url: "https://example/pr/42",
  }));
  const cleanup = vi.fn(async () => undefined);
  const events: unknown[] = [];
  const internals = service as unknown as {
    workspaceService: { cleanup: typeof cleanup; finalize: typeof finalize };
    workspaces: Map<string, typeof workspace>;
  };
  internals.workspaceService = { cleanup, finalize };
  internals.workspaces.set("workspace-1", { ...workspace });
  service.onEvent((event) => events.push(event));
  return { service, finalize, cleanup, reportError, events };
}

function tmpRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function makeScratchDir(root: string, name: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "payload.txt"), "scratch payload");
  return dir;
}

const options = { title: "Safe change", body: "Body" };

beforeEach(() => capturePrGateChangeSet.mockReset());
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("CodingWorkspaceService.createPR diff-review boundary", () => {
  it("passes a clean complete scan to finalize", async () => {
    capturePrGateChangeSet.mockResolvedValue({
      changedFiles: ["src/safe.ts"],
      diff: "+++ b/src/safe.ts\n+export const safe = true;\n",
      truncated: false,
      filesTruncated: false,
    });
    const { service, finalize, events } = harness();

    await expect(
      service.createPR("workspace-1", options),
    ).resolves.toMatchObject({ number: 42 });
    expect(finalize).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({
        pr: expect.objectContaining({ targetBranch: "main" }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "workspace:finalizing",
        data: expect.objectContaining({
          diffGate: expect.objectContaining({ outcome: "passed" }),
        }),
      }),
    );
  });

  it("uses an explicit PR base for both gate capture and finalization", async () => {
    capturePrGateChangeSet.mockResolvedValue({
      changedFiles: ["src/safe.ts"],
      diff: "+++ b/src/safe.ts\n+export const safe = true;\n",
      truncated: false,
      filesTruncated: false,
    });
    const { service, finalize } = harness();

    await service.createPR("workspace-1", { ...options, base: "develop" });

    expect(capturePrGateChangeSet).toHaveBeenCalledWith(
      "/tmp/gate-workspace",
      "develop",
    );
    expect(finalize).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({
        pr: expect.objectContaining({ targetBranch: "develop" }),
      }),
    );
  });

  it("allows the explicit disable seam to bypass capture and finalize normally", async () => {
    vi.stubEnv("ELIZA_CODING_DIFF_GATE_DISABLED", "true");
    const { service, finalize, events } = harness();

    await expect(
      service.createPR("workspace-1", options),
    ).resolves.toMatchObject({ number: 42 });

    expect(capturePrGateChangeSet).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledOnce();
    expect(events).toEqual([]);
  });

  it("annotates a warning and still finalizes", async () => {
    capturePrGateChangeSet.mockResolvedValue({
      changedFiles: ["src/large.ts"],
      diff: "+++ b/src/large.ts\n+a\n+b\n+c\n",
      truncated: false,
      filesTruncated: false,
    });
    vi.stubEnv("ELIZA_CODING_DIFF_GATE_OVERSIZE_LINES", "2");
    const { service, finalize } = harness();

    await service.createPR("workspace-1", options);
    expect(finalize).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({
        pr: expect.objectContaining({
          body: expect.stringContaining("Diff-review gate"),
        }),
      }),
    );
  });

  it.each([
    [
      "secret",
      {
        changedFiles: ["config.ts"],
        diff: "+++ b/config.ts\n+password=not-a-real-secret-value\n",
        truncated: false,
        filesTruncated: false,
      },
    ],
    [
      "truncated diff",
      {
        changedFiles: ["src/a.ts"],
        diff: "+safe\n",
        truncated: true,
        filesTruncated: false,
      },
    ],
    [
      "truncated file list",
      {
        changedFiles: ["src/a.ts"],
        diff: "+safe\n",
        truncated: false,
        filesTruncated: true,
      },
    ],
  ])("blocks %s without finalizing", async (_case, changeSet) => {
    capturePrGateChangeSet.mockResolvedValue(changeSet);
    const { service, finalize, events } = harness();

    await expect(
      service.createPR("workspace-1", options),
    ).rejects.toBeInstanceOf(DiffGateBlockedError);
    expect(finalize).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          diffGate: expect.objectContaining({ outcome: "blocked" }),
        }),
      }),
    );
  });

  it("reports unavailable capture and never finalizes", async () => {
    capturePrGateChangeSet.mockResolvedValue(undefined);
    const { service, finalize, reportError, events } = harness();

    let caught: unknown;
    try {
      await service.createPR("workspace-1", options);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "CODING_DIFF_GATE_CAPTURE_FAILED" });
    expect(finalize).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledOnce();
    expect(events).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          diffGate: expect.objectContaining({ outcome: "capture_failed" }),
        }),
      }),
    );
  });

  it("invalid forbidden-path configuration blocks before finalize", async () => {
    capturePrGateChangeSet.mockResolvedValue({
      changedFiles: ["src/a.ts"],
      diff: "+safe\n",
      truncated: false,
      filesTruncated: false,
    });
    vi.stubEnv("ELIZA_CODING_DIFF_GATE_EXTRA_FORBIDDEN", "[");
    const { service, finalize, reportError } = harness();

    await expect(
      service.createPR("workspace-1", options),
    ).rejects.toMatchObject({
      code: "INVALID_CODING_DIFF_GATE_PATTERN",
    });
    expect(finalize).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledOnce();
  });

  it("honors non-blocking diff gate config without annotating the PR body", async () => {
    capturePrGateChangeSet.mockResolvedValue({
      changedFiles: ["src/large.ts"],
      diff: "+++ b/src/large.ts\n+a\n+b\n+c\n",
      truncated: false,
      filesTruncated: false,
    });
    vi.stubEnv("ELIZA_CODING_DIFF_GATE_OVERSIZE_LINES", "2");
    vi.stubEnv("ELIZA_CODING_DIFF_GATE_NO_OVERSIZE", "true");
    const { service, finalize } = harness();

    await service.createPR("workspace-1", options);

    expect(finalize).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({
        pr: expect.objectContaining({ body: options.body }),
      }),
    );
  });

  it("throws before gate capture when the service is not initialized or workspace is unknown", async () => {
    const runtime = {
      getSetting: vi.fn(() => undefined),
      reportError: vi.fn(),
    } as unknown as IAgentRuntime;
    const service = new CodingWorkspaceService(runtime);

    await expect(service.createPR("workspace-1", options)).rejects.toThrow(
      "CodingWorkspaceService not initialized",
    );

    const { service: initialized } = harness();
    await expect(initialized.createPR("missing", options)).rejects.toThrow(
      "Workspace missing not found",
    );
    expect(capturePrGateChangeSet).not.toHaveBeenCalled();
  });
});

describe("CodingWorkspaceService workspace lifecycle seams", () => {
  it("labels, resolves, and removes a finalized workspace from the service maps", async () => {
    const { service, cleanup } = harness();

    service.setLabel("workspace-1", "review-target");
    expect(service.resolveWorkspace("review-target")).toMatchObject({
      id: "execution-1",
    });
    expect(service.listWorkspaces()).toHaveLength(1);

    await service.removeWorkspace("workspace-1");

    expect(cleanup).toHaveBeenCalledWith("workspace-1");
    expect(service.getWorkspace("workspace-1")).toBeUndefined();
    expect(service.getWorkspaceByLabel("review-target")).toBeUndefined();
  });

  it("continues event delivery when one subscriber throws and supports unsubscribe", () => {
    const { service } = harness();
    const throwing = vi.fn(() => {
      throw new Error("subscriber failed");
    });
    const receiving = vi.fn();
    const unsubscribe = service.onEvent(throwing);
    service.onEvent(receiving);

    (
      service as unknown as {
        emitEvent(event: unknown): void;
      }
    ).emitEvent({ type: "workspace:finalizing", workspaceId: "workspace-1" });
    unsubscribe();
    (
      service as unknown as {
        emitEvent(event: unknown): void;
      }
    ).emitEvent({ type: "workspace:finalizing", workspaceId: "workspace-1" });

    expect(throwing).toHaveBeenCalledOnce();
    expect(receiving).toHaveBeenCalledTimes(2);
  });

  it("drives scratch retention through pending, keep, promote, and delete", async () => {
    const root = tmpRoot("workspace-service-scratch-");
    const source = await makeScratchDir(root, "task-source");
    vi.stubEnv("ELIZA_SCRATCH_DECISION_TTL_MS", "60000");
    const runtime = {
      getSetting: vi.fn((key: string) =>
        key === "ELIZA_SCRATCH_RETENTION" ? "pending_decision" : undefined,
      ),
      reportError: vi.fn(),
    } as unknown as IAgentRuntime;
    const service = new CodingWorkspaceService(runtime, { baseDir: root });
    const prompt = vi.fn(async () => undefined);
    service.setScratchDecisionCallback(prompt);

    const pending = await service.registerScratchWorkspace(
      "session-1",
      source,
      "Feature Branch",
      "task_complete",
    );
    expect(pending).toMatchObject({ status: "pending_decision" });
    expect(prompt).toHaveBeenCalledOnce();

    const kept = await service.keepScratchWorkspace("session-1");
    expect(kept.status).toBe("kept");

    const promoted = await service.promoteScratchWorkspace(
      "session-1",
      "Feature Branch",
    );
    expect(promoted.status).toBe("promoted");
    expect(promoted.path).toBe(join(root, "feature-branch"));
    expect(existsSync(promoted.path)).toBe(true);

    await service.deleteScratchWorkspace("session-1");
    expect(existsSync(promoted.path)).toBe(false);
    expect(service.listScratchWorkspaces()).toEqual([]);
  });

  it("stops by clearing scratch timers and best-effort cleaning every workspace", async () => {
    const { service } = harness();
    const cleanup = vi
      .fn()
      .mockRejectedValueOnce(new Error("first cleanup failed"))
      .mockResolvedValueOnce(undefined);
    const internals = service as unknown as {
      credentialService: unknown;
      githubClient: unknown;
      scratchCleanupTimers: Map<string, ReturnType<typeof setTimeout>>;
      workspaceService: { cleanup: typeof cleanup } | null;
      workspaces: Map<string, typeof workspace>;
    };
    internals.workspaceService = { cleanup };
    internals.credentialService = {};
    internals.githubClient = {};
    internals.workspaces.set("workspace-2", {
      ...workspace,
      id: "execution-2",
      isWorktree: true,
    });
    internals.scratchCleanupTimers.set(
      "session-1",
      setTimeout(() => {}, 1000),
    );

    await service.stop();

    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(internals.scratchCleanupTimers.size).toBe(0);
    expect(internals.workspaces.size).toBe(0);
    expect(internals.workspaceService).toBeNull();
    expect(internals.credentialService).toBeNull();
    expect(internals.githubClient).toBeNull();
  });

  it("deletes ephemeral scratch workspaces and keeps named coding-directory workspaces by default", async () => {
    const root = tmpRoot("workspace-service-retention-");
    const ephemeralSource = await makeScratchDir(root, "ephemeral-source");
    const persistentSource = await makeScratchDir(root, "persistent-source");
    const runtime = {
      getSetting: vi.fn((key: string) => {
        if (key === "ELIZA_SCRATCH_RETENTION") return "ephemeral";
        return undefined;
      }),
      reportError: vi.fn(),
    } as unknown as IAgentRuntime;
    const service = new CodingWorkspaceService(runtime, { baseDir: root });

    const ephemeral = await service.registerScratchWorkspace(
      "session-ephemeral",
      ephemeralSource,
      "Ephemeral task",
      "stopped",
    );
    expect(ephemeral).toBeNull();
    expect(existsSync(ephemeralSource)).toBe(false);

    runtime.getSetting = vi.fn((key: string) => {
      if (key === "ELIZA_CODING_DIRECTORY") return root;
      return undefined;
    });
    const persistent = await service.registerScratchWorkspace(
      "session-persistent",
      persistentSource,
      "Persistent task",
      "task_complete",
    );

    expect(persistent).toMatchObject({ status: "kept" });
    expect(existsSync(persistentSource)).toBe(true);
  });
});
