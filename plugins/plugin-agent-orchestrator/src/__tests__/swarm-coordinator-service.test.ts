/**
 * Admin-stop suppression in the coordinator's `stopped` synthesis.
 *
 * A lifecycle teardown (task archive/delete/pause, user stop) stamps
 * `adminStopReason` on the session before stopping it; the coordinator must
 * suppress its "stopped before completion" synthesis for that stop WITHOUT
 * claiming the per-session dedupe slot, so a later genuine terminal for the
 * same session still posts. An UNMARKED stop (crash, subprocess death) must
 * keep synthesizing — the #11689 never-silent-terminal invariant is the
 * regression line. Deterministic harness: real SwarmCoordinatorService bound
 * to a fake ACP event stream; only the ACP surface is faked.
 */

import { describe, expect, it, vi } from "vitest";
import { AcpService } from "../services/acp-service.ts";
import { ADMIN_STOP_META_KEY,
  ADMIN_STOP_STAMPED_AT_META_KEY } from "../services/admin-stop-marker.ts";
import { SwarmCoordinatorService } from "../services/swarm-coordinator-service.ts";

type EventHandler = (sessionId: string, event: string, data: unknown) => void;

class FakeAcp {
  static serviceType = AcpService.serviceType;
  readonly metadataById = new Map<string, Record<string, unknown>>();
  private handler: EventHandler | undefined;

  async getSession(id: string) {
    const metadata = this.metadataById.get(id);
    if (!metadata) return undefined;
    return {
      id,
      status: "stopped",
      metadata,
    };
  }

  async updateSessionMetadata(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const current = this.metadataById.get(id) ?? {};
    this.metadataById.set(id, { ...current, ...patch });
  }

  onSessionEvent(cb: EventHandler): () => void {
    this.handler = cb;
    return () => {
      this.handler = undefined;
    };
  }

  emit(sessionId: string, event: string, data: unknown = {}): void {
    this.handler?.(sessionId, event, data);
  }
}

function makeRuntime(acp: FakeAcp): Record<string, unknown> {
  return {
    agentId: "00000000-0000-4000-8000-000000000021",
    character: { name: "Coordinator" },
    reportError: vi.fn(),
    getService: (type: string) =>
      type === AcpService.serviceType ? acp : undefined,
  };
}

async function settle(ms = 30): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function harness() {
  const acp = new FakeAcp();
  const service = await SwarmCoordinatorService.start(
    makeRuntime(acp) as never,
  );
  const completions: Array<{ sessionId: string; status: string }> = [];
  service.setSwarmCompleteCallback(async (payload) => {
    for (const task of payload.tasks) {
      completions.push({ sessionId: task.sessionId, status: task.status });
    }
  });
  return { acp, service, completions };
}

describe("swarm-coordinator admin-stop suppression", () => {
  it("suppresses a stopped terminal whose FRESH metadata carries adminStopReason, without claiming the dedupe slot", async () => {
    const { acp, service, completions } = await harness();
    acp.metadataById.set("s1", {
      label: "builder",
      [ADMIN_STOP_META_KEY]: "task_lifecycle",
      // Freshness-scoped (#22981): a stamp without a current timestamp is
      // treated as a failed-stop survivor and synthesizes.
      [ADMIN_STOP_STAMPED_AT_META_KEY]: new Date().toISOString(),
    });

    acp.emit("s1", "stopped", { label: "builder" });
    await settle();
    expect(completions).toHaveLength(0);

    // The suppression must NOT have claimed the synthesis slot: a later
    // genuine (unmarked) terminal for the same session still posts.
    acp.metadataById.set("s1", { label: "builder" });
    acp.emit("s1", "stopped", { label: "builder" });
    await settle();
    expect(completions).toHaveLength(1);
    expect(completions[0]).toEqual({ sessionId: "s1", status: "stopped" });

    await service.stop();
  });

  it("still synthesizes an unmarked stop (#11689 never-silent invariant)", async () => {
    const { acp, service, completions } = await harness();
    acp.metadataById.set("s2", { label: "crasher" });

    acp.emit("s2", "stopped", { label: "crasher" });
    await settle();
    expect(completions).toHaveLength(1);
    expect(completions[0]).toEqual({ sessionId: "s2", status: "stopped" });

    await service.stop();
  });

  it("reads the marker through the FRESH re-read, not the pre-stamp cache", async () => {
    const { acp, service, completions } = await harness();
    // Warm the enrichment cache with a PRE-stamp snapshot (a non-terminal
    // event), then stamp, then stop: the stale cache must not defeat the
    // suppression.
    acp.metadataById.set("s3", { label: "late-stamp" });
    acp.emit("s3", "ready", {});
    await settle();
    acp.metadataById.set("s3", {
      label: "late-stamp",
      [ADMIN_STOP_META_KEY]: "user_stop",
      [ADMIN_STOP_STAMPED_AT_META_KEY]: new Date().toISOString(),
    });

    acp.emit("s3", "stopped", { label: "late-stamp" });
    await settle();
    expect(completions).toHaveLength(0);

    await service.stop();
  });
});
