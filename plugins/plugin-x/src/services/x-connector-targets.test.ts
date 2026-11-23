/**
 * Connector target resolution: an X profile lookup that fails for an
 * operational reason (rate limit, auth expiry, network) must not be reported
 * to the caller as "no such handle". `fetchProfile` already answers a real
 * unknown handle with an `X_PROFILE_NOT_FOUND` ElizaError, so that one case
 * may still resolve to an empty list.
 */
import {
  ElizaError,
  type IAgentRuntime,
  type MessageConnectorQueryContext,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { ClientBase } from "../base";
import { XService } from "./x.service";

const AGENT_ID = "00000000-0000-0000-0000-0000000000a1" as UUID;

function createContext(runtime: IAgentRuntime): MessageConnectorQueryContext {
  return {
    runtime,
    target: { source: "x", entityId: "default" },
  } as unknown as MessageConnectorQueryContext;
}

function createService(fetchProfile: (name: string) => Promise<unknown>) {
  const runtime = {
    agentId: AGENT_ID,
    character: { name: "Agent" },
    getSetting: vi.fn(() => undefined),
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
  const service = Object.create(XService.prototype) as XService & {
    runtime: IAgentRuntime;
    defaultAccountId: string;
    getTwitterClientForAccount: (id?: unknown) => Promise<unknown>;
  };
  service.runtime = runtime;
  service.defaultAccountId = "default";
  service.getTwitterClientForAccount = vi.fn(async () => ({
    client: {
      fetchProfile: vi.fn(fetchProfile),
    } as unknown as ClientBase,
  }));
  return { service, runtime };
}

describe("XService.resolveConnectorTargets lookup failures", () => {
  it("propagates a rate-limited lookup instead of returning no targets", async () => {
    const rateLimited = Object.assign(
      new Error("Request failed with code 429"),
      { code: 429 },
    );
    const { service, runtime } = createService(async () => {
      throw rateLimited;
    });

    await expect(
      service.resolveConnectorTargets("@alice", createContext(runtime)),
    ).rejects.toThrow("Request failed with code 429");
  });

  it("still resolves an unknown handle to an empty target list", async () => {
    const notFound = new ElizaError("X profile @ghost was not found", {
      code: "X_PROFILE_NOT_FOUND",
      context: { username: "ghost" },
    });
    const { service, runtime } = createService(async () => {
      throw notFound;
    });

    await expect(
      service.resolveConnectorTargets("@ghost", createContext(runtime)),
    ).resolves.toEqual([]);
  });

  it("resolves a known handle to its user target", async () => {
    const { service, runtime } = createService(async () => ({
      id: "4242",
      username: "alice",
      screenName: "Alice",
      bio: "",
      nicknames: [],
    }));

    const targets = await service.resolveConnectorTargets(
      "@alice",
      createContext(runtime),
    );

    expect(targets).toHaveLength(1);
    expect(targets[0].target).toMatchObject({
      source: "x",
      entityId: "4242",
      accountId: "default",
    });
  });
});
