/**
 * Verifies awaitCodingSupervisionBound: the structural spawn gate over the
 * swarm coordinator's observable ACP bind state (boot-race defect — spawns
 * black-holing while the coordinator sits "ACP stream not bound").
 * Deterministic unit test with a stubbed runtime; real timers, tiny timeouts.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { awaitCodingSupervisionBound } from "../../src/actions/common.js";

function runtimeWithCoordinator(coordinator: unknown): IAgentRuntime {
  return {
    getService: vi.fn((type: string) =>
      type === "SWARM_COORDINATOR" ? coordinator : null,
    ),
    getSetting: vi.fn(() => undefined),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as never;
}

describe("awaitCodingSupervisionBound", () => {
  it("passes immediately when the coordinator reports bound", async () => {
    const runtime = runtimeWithCoordinator({
      acpBindState: { status: "bound", reason: null, attempts: 1 },
    });
    await expect(awaitCodingSupervisionBound(runtime)).resolves.toEqual({
      ok: true,
    });
  });

  it("passes when no coordinator is registered (nothing to gate)", async () => {
    await expect(
      awaitCodingSupervisionBound(runtimeWithCoordinator(null)),
    ).resolves.toEqual({ ok: true });
  });

  it("passes when the coordinator lacks an observable bind state", async () => {
    await expect(
      awaitCodingSupervisionBound(runtimeWithCoordinator({})),
    ).resolves.toEqual({ ok: true });
    await expect(
      awaitCodingSupervisionBound(
        runtimeWithCoordinator({ acpBindState: { status: "weird" } }),
      ),
    ).resolves.toEqual({ ok: true });
  });

  it("fails immediately with the recorded reason when unbound", async () => {
    const runtime = runtimeWithCoordinator({
      acpBindState: {
        status: "unbound",
        reason: "ACP service failed to start",
        attempts: 4,
      },
    });
    await expect(awaitCodingSupervisionBound(runtime)).resolves.toEqual({
      ok: false,
      reason: "ACP service failed to start",
    });
  });

  it("resolves ok when a pending bind flips to bound mid-poll", async () => {
    const bindState = {
      status: "pending" as string,
      reason: null as string | null,
      attempts: 1,
    };
    const runtime = runtimeWithCoordinator({
      get acpBindState() {
        return bindState;
      },
    });
    const timer = setTimeout(() => {
      bindState.status = "bound";
    }, 120);
    timer.unref?.();
    await expect(awaitCodingSupervisionBound(runtime, 2_000)).resolves.toEqual({
      ok: true,
    });
  });

  it("fails with a status=pending reason after the timeout", async () => {
    const runtime = runtimeWithCoordinator({
      acpBindState: { status: "pending", reason: null, attempts: 2 },
    });
    const result = await awaitCodingSupervisionBound(runtime, 60);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("status=pending");
      expect(result.reason).toContain("60ms");
    }
  });
});
