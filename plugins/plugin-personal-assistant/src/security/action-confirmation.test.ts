import { __setGateDestructiveConfirmationResult } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  lifeOpsConfirmationBlocked,
  requireLifeOpsUserConfirmation,
} from "./action-confirmation";

function makeArgs(overrides: Record<string, unknown> = {}) {
  return {
    runtime: { name: "test" },
    message: { id: "m1" },
    actionName: "wipe-disk",
    pendingKey: "wipe-disk:pending",
    prompt: "Really wipe the disk?",
    callback: vi.fn(),
    ...overrides,
  } as never;
}

describe("requireLifeOpsUserConfirmation", () => {
  beforeEach(() => {
    __setGateDestructiveConfirmationResult({ status: "confirmed" });
  });

  it("returns the gate status for confirmed", async () => {
    __setGateDestructiveConfirmationResult({ status: "confirmed" });
    await expect(requireLifeOpsUserConfirmation(makeArgs())).resolves.toBe(
      "confirmed",
    );
  });

  it("returns the gate status for pending", async () => {
    __setGateDestructiveConfirmationResult({ status: "pending" });
    await expect(requireLifeOpsUserConfirmation(makeArgs())).resolves.toBe(
      "pending",
    );
  });

  it("returns the gate status for cancelled", async () => {
    __setGateDestructiveConfirmationResult({ status: "cancelled" });
    await expect(requireLifeOpsUserConfirmation(makeArgs())).resolves.toBe(
      "cancelled",
    );
  });
});

describe("lifeOpsConfirmationBlocked", () => {
  it("maps cancelled to a success result carrying cancelled:true", () => {
    expect(lifeOpsConfirmationBlocked("cancelled", "proceed?")).toEqual({
      success: true,
      text: "Cancelled.",
      data: { cancelled: true },
    });
  });

  it("spreads extra data into the cancelled result", () => {
    expect(
      lifeOpsConfirmationBlocked("cancelled", "proceed?", { actionName: "x" }),
    ).toEqual({
      success: true,
      text: "Cancelled.",
      data: { cancelled: true, actionName: "x" },
    });
  });

  it("maps pending to an awaiting-confirmation draft result", () => {
    expect(lifeOpsConfirmationBlocked("pending", "proceed?")).toEqual({
      success: true,
      text: "proceed? Reply yes to confirm or no to cancel.",
      data: {
        requiresConfirmation: true,
        draft: true,
        awaitingUserInput: true,
      },
    });
  });

  it("spreads extra data into the pending result", () => {
    const r = lifeOpsConfirmationBlocked("pending", "proceed?", {
      source: "timer",
    });
    expect(r.data).toEqual({
      requiresConfirmation: true,
      draft: true,
      awaitingUserInput: true,
      source: "timer",
    });
  });
});
