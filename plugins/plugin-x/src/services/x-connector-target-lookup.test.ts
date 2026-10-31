/**
 * An X DM recipient lookup that fails must not come back as "no such user".
 *
 * `resolveConnectorTargets` resolves a typed handle to a user id before a DM is
 * sent. When the provider lookup is rate limited, rejects the credentials, or
 * cannot reach X, the caller (`MESSAGE/send`, `ConnectorAction`) is told that
 * zero targets matched the query — indistinguishable from a handle that really
 * does not exist. Those callers already have an explicit failure path, so the
 * provider failure has to reach them.
 */
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { XService } from "./x.service";

function harness(fetchProfile: (name: string) => Promise<never>) {
  const service = Object.create(XService.prototype) as XService & {
    defaultAccountId: string;
    getTwitterClientForAccount: unknown;
  };
  service.defaultAccountId = "default";
  service.getTwitterClientForAccount = async () => ({
    client: { fetchProfile },
  });
  const runtime = {
    agentId: "00000000-0000-4000-8000-000000000001",
  } as unknown as IAgentRuntime;
  const resolve = (query: string) =>
    service.resolveConnectorTargets(query, {} as never);
  return { runtime, resolve };
}

describe("X connector recipient lookup", () => {
  it("propagates a rate-limited profile lookup instead of reporting no match", async () => {
    const rateLimited = Object.assign(new Error("Rate limit exceeded"), {
      code: 429,
      data: { status: 429 },
    });
    const { resolve } = harness(async () => {
      throw rateLimited;
    });

    await expect(resolve("someone_i_follow")).rejects.toBe(rateLimited);
  });

  it("propagates an auth failure instead of reporting no match", async () => {
    const unauthorized = Object.assign(new Error("Unauthorized"), {
      code: 401,
    });
    const { resolve } = harness(async () => {
      throw unauthorized;
    });

    await expect(resolve("someone_i_follow")).rejects.toBe(unauthorized);
  });

  it("still reports no match when X says the handle does not exist", async () => {
    const { resolve } = harness(async () => {
      throw new ElizaError("X profile @nobody_here_9f3 was not found", {
        code: "X_PROFILE_NOT_FOUND",
      });
    });

    await expect(resolve("nobody_here_9f3")).resolves.toEqual([]);
  });
});
