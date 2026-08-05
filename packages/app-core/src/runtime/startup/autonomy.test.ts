/**
 * Verifies autonomy startup status and failure reporting with a deterministic
 * mocked service boundary; no persistence or continuous loop is started.
 */
import type { AgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  start: vi.fn(),
}));

vi.mock("@elizaos/core", () => ({
  AUTONOMY_SERVICE_TYPE: "AUTONOMY",
  AutonomyService: { start: mocks.start },
  ChannelType: { SELF: "SELF" },
  ElizaError: class ElizaError extends Error {
    readonly code: string;

    constructor(message: string, options: { code: string; cause?: unknown }) {
      super(message, { cause: options.cause });
      this.code = options.code;
    }
  },
  logger: { info: mocks.info },
  stringToUuid: (value: string) => value,
}));

import { configureAutonomy } from "./autonomy.ts";

function runtimeStub(existingService?: object): AgentRuntime {
  const services = new Map<string, object[]>();
  if (existingService) services.set("AUTONOMY", [existingService]);
  return {
    agentId: "agent-id",
    services,
    getService: (type: string) => services.get(type)?.[0] ?? null,
  } as unknown as AgentRuntime;
}

describe("configureAutonomy", () => {
  beforeEach(() => {
    mocks.info.mockReset();
    mocks.start.mockReset();
  });

  it("reports one actionable state when the continuous loop is disabled", async () => {
    const service = { enableAutonomy: vi.fn() };
    mocks.start.mockResolvedValue(service);

    await configureAutonomy(runtimeStub(), false);

    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.info).toHaveBeenCalledExactlyOnceWith(
      "[eliza] Autonomy loop disabled; trigger service ready — set ENABLE_AUTONOMY=true to enable continuous autonomy",
    );
  });

  it("preserves startup failures instead of logging a healthy state", async () => {
    mocks.start.mockRejectedValue(new Error("service unavailable"));

    await expect(configureAutonomy(runtimeStub(), false)).rejects.toMatchObject(
      {
        code: "APP_AUTONOMY_START_FAILED",
      },
    );
    expect(mocks.info).not.toHaveBeenCalled();
  });
});
