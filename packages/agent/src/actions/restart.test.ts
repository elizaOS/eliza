/**
 * RESTART_AGENT action tests.
 *
 * Verifies the dev-mode self-edit gate: when a restart is tagged
 * `source: "self-edit"` it must be refused unless `isSelfEditEnabled()` is
 * true. Other sources (`user`, `plugin-install`) bypass the gate.
 */

import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../security/access.js", () => ({
  hasOwnerAccess: vi.fn(async () => true),
}));

const requestRestartMock = vi.fn();
vi.mock("../runtime/restart.js", () => ({
  requestRestart: (...args: unknown[]) => requestRestartMock(...args),
}));

import { restartAction } from "./restart.js";

const fakeRuntime = {
  agentId: "agent-id" as UUID,
  createMemory: vi.fn(async () => undefined),
} as unknown as IAgentRuntime;

const explicitRestartMessage: Memory = {
  id: "msg-1" as UUID,
  entityId: "user-1" as UUID,
  roomId: "room-1" as UUID,
  worldId: "world-1" as UUID,
  content: { text: "/restart" },
};

type RestartHandlerOptions = Parameters<typeof restartAction.handler>[3];

function buildOptions(
  parameters: Record<string, unknown>,
): RestartHandlerOptions {
  return { parameters } as unknown as RestartHandlerOptions;
}

describe("restartAction self-edit gate", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    requestRestartMock.mockReset();
    vi.useFakeTimers();
    delete process.env.MILADY_ENABLE_SELF_EDIT;
    delete process.env.MILADY_DEV_MODE;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = { ...ORIGINAL_ENV };
  });

  it("refuses a self-edit-sourced restart when MILADY_ENABLE_SELF_EDIT is unset", async () => {
    const result = await restartAction.handler(
      fakeRuntime,
      explicitRestartMessage,
      undefined,
      buildOptions({ source: "self-edit", reason: "patched prompt" }),
    );

    expect(result?.success).toBe(false);
    expect(result?.text).toMatch(
      /Refused: self-edit restart requires dev mode/,
    );
    expect(result?.data).toMatchObject({
      reason: "patched prompt",
      source: "self-edit",
      refused: "self-edit-not-enabled",
    });
    // requestRestart is scheduled with setTimeout in the success path; advance
    // the timers to prove the refusal short-circuits the schedule entirely.
    vi.runAllTimers();
    expect(requestRestartMock).not.toHaveBeenCalled();
    expect(fakeRuntime.createMemory).not.toHaveBeenCalled();
  });

  it("refuses self-edit restart in production even with MILADY_ENABLE_SELF_EDIT=1", async () => {
    process.env.MILADY_ENABLE_SELF_EDIT = "1";
    process.env.NODE_ENV = "production";

    const result = await restartAction.handler(
      fakeRuntime,
      explicitRestartMessage,
      undefined,
      buildOptions({ source: "self-edit" }),
    );

    expect(result?.success).toBe(false);
    expect(result?.data).toMatchObject({ refused: "self-edit-not-enabled" });
  });

  it("allows a self-edit restart when the dev-mode gate is open", async () => {
    process.env.MILADY_ENABLE_SELF_EDIT = "1";
    process.env.NODE_ENV = "development";

    const result = await restartAction.handler(
      fakeRuntime,
      explicitRestartMessage,
      undefined,
      buildOptions({ source: "self-edit", reason: "patched prompt" }),
    );

    expect(result?.success).toBe(true);
    expect(result?.text).toBe("Restarting… (patched prompt)");
    expect(result?.data).toMatchObject({
      reason: "patched prompt",
      source: "self-edit",
    });

    vi.runAllTimers();
    expect(requestRestartMock).toHaveBeenCalledTimes(1);
    expect(requestRestartMock).toHaveBeenCalledWith("patched prompt");
  });

  it("allows a user-sourced restart even when self-edit is disabled", async () => {
    const result = await restartAction.handler(
      fakeRuntime,
      explicitRestartMessage,
      undefined,
      buildOptions({ source: "user", reason: "config reload" }),
    );

    expect(result?.success).toBe(true);
    expect(result?.text).toBe("Restarting… (config reload)");
    expect(result?.data).toMatchObject({ source: "user" });

    vi.runAllTimers();
    expect(requestRestartMock).toHaveBeenCalledTimes(1);
  });

  it("allows a restart with no source (defaults to bypassing the gate)", async () => {
    const result = await restartAction.handler(
      fakeRuntime,
      explicitRestartMessage,
      undefined,
      buildOptions({}),
    );

    expect(result?.success).toBe(true);
    expect(result?.text).toBe("Restarting…");

    vi.runAllTimers();
    expect(requestRestartMock).toHaveBeenCalledTimes(1);
  });

  it("ignores an unknown source string (treats as undefined)", async () => {
    const result = await restartAction.handler(
      fakeRuntime,
      explicitRestartMessage,
      undefined,
      buildOptions({ source: "rogue-actor" }),
    );

    expect(result?.success).toBe(true);
    expect(result?.data).toMatchObject({ source: undefined });

    vi.runAllTimers();
    expect(requestRestartMock).toHaveBeenCalledTimes(1);
  });
});
