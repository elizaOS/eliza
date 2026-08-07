/**
 * Real-path regression for the disk-budget + registry integration in
 * AcpService.spawnSession (#13773). Drives the production spawn path against a
 * real InMemorySessionStore and real temp dirs: a spawn that fails AFTER the
 * isolated scratch dir is created (here: the session-slot cap is already full)
 * must remove the orphaned dir and drop its registry entry, so a failed spawn
 * never pins the shared cap (#13803 review blocker #2). No mocks of the cleanup.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ElizaError } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpService } from "../services/acp-service.ts";
import { InMemorySessionStore } from "../services/session-store.ts";
import type { SessionInfo } from "../services/types.ts";
import {
  getSharedWorkspaceRegistry,
  resetSharedWorkspaceRegistry,
} from "../services/workspace-registry.ts";

const roots: string[] = [];

beforeEach(() => {
  resetSharedWorkspaceRegistry();
});

afterEach(() => {
  resetSharedWorkspaceRegistry();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "acp-disk-budget-"));
  roots.push(root);
  return root;
}

function makeRuntime(
  settings: Record<string, string> = {},
): Record<string, unknown> {
  return {
    agentId: "00000000-0000-4000-8000-00000013773b",
    character: { name: "Tester" },
    getSetting: (key: string) => settings[key],
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    reportError() {},
    getService: () => null,
  };
}

function workerSession(id: string): SessionInfo {
  const now = new Date();
  return {
    id,
    name: id,
    agentType: "opencode",
    workdir: "/tmp/preexisting",
    status: "running",
    approvalPreset: "standard",
    createdAt: now,
    lastActivityAt: now,
    metadata: { slotClass: "worker" },
  };
}

describe("AcpService spawn disk-budget + registry (#13773)", () => {
  it("removes the orphaned scratch dir and unregisters when a spawn fails after mkdir", async () => {
    const root = tmpRoot();
    const store = new InMemorySessionStore();
    // Fill the single worker slot so the next spawn's reserveSessionSlot throws
    // AFTER computeSessionWorkdir + mkdir + register have already run.
    await store.create(workerSession("existing-1"));

    const svc = new AcpService(
      makeRuntime({
        ELIZA_ACP_MAX_SESSIONS: "1",
        ELIZA_ACP_SYSTEM_SESSION_HEADROOM: "0",
        ELIZA_ACP_WORKSPACE_ROOT: root,
      }) as never,
      { store },
    );
    (svc as unknown as { started: boolean }).started = true;

    const registry = getSharedWorkspaceRegistry();
    const before = registry.size();

    await expect(
      svc.spawnSession({ agentType: "opencode", slotClass: "worker" }),
    ).rejects.toThrow();

    // No leaked task-* dir under the configured root, and no live registry entry
    // pinning the cap.
    const leaked = readdirSync(root).filter((n) => n.startsWith("task-"));
    expect(leaked).toEqual([]);
    expect(registry.size()).toBe(before);
  });

  it("preserves the scratch dir when a durable CLI session fails to start", async () => {
    const root = tmpRoot();
    const store = new InMemorySessionStore();
    const svc = new AcpService(
      makeRuntime({
        ELIZA_ACP_TRANSPORT: "cli",
        ELIZA_ACP_WORKSPACE_ROOT: root,
      }) as never,
      { store },
    );
    (svc as unknown as { started: boolean }).started = true;
    (
      svc as unknown as {
        runAcpx: () => Promise<{
          code: number;
          stdout: string;
          stderr: string;
        }>;
      }
    ).runAcpx = async () => ({
      code: 1,
      stdout: "",
      stderr: "startup failed",
    });

    await expect(
      svc.spawnSession({ agentType: "opencode", slotClass: "worker" }),
    ).rejects.toThrow();

    const [session] = await store.list();
    expect(session).toMatchObject({
      status: "errored",
      lastError: expect.stringContaining("startup failed"),
    });
    expect(existsSync(session.workdir)).toBe(true);
    expect(getSharedWorkspaceRegistry().isLive(session.workdir)).toBe(false);
  });

  it("refuses a spawn when the free-disk floor cannot be met", async () => {
    const root = tmpRoot();
    const store = new InMemorySessionStore();
    const svc = new AcpService(
      makeRuntime({
        ELIZA_ACP_WORKSPACE_ROOT: root,
        // A floor no real filesystem can satisfy forces the precheck to refuse
        // before any mkdir happens.
        ELIZA_WORKSPACE_MIN_FREE_BYTES: String(Number.MAX_SAFE_INTEGER),
      }) as never,
      { store },
    );
    (svc as unknown as { started: boolean }).started = true;

    let refusal: unknown;
    try {
      await svc.spawnSession({ agentType: "opencode", slotClass: "worker" });
    } catch (err) {
      refusal = err;
    }
    // The refusal is a structured ElizaError whose MESSAGE is chat-safe (an
    // action boundary relays it toward the user verbatim): human words, no
    // byte counts, no filesystem paths. The technical fields ride `context`.
    expect(refusal).toBeInstanceOf(ElizaError);
    const budgetError = refusal as ElizaError;
    expect(budgetError.code).toBe("WORKSPACE_DISK_BUDGET_EXCEEDED");
    expect(budgetError.message).toBe(
      "the workspace disk is nearly full, so a new coding workspace cannot be created right now",
    );
    expect(budgetError.message).not.toMatch(/\d/);
    expect(budgetError.message).not.toContain(root);
    expect(budgetError.context).toMatchObject({
      reason: "free-disk-floor",
      minFreeBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(typeof budgetError.context?.freeBytes).toBe("number");
    expect(typeof budgetError.context?.usedBytes).toBe("number");
    expect(String(budgetError.context?.targetRoot)).toContain(root);

    expect(readdirSync(root)).toEqual([]);
  });
});
