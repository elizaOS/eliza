/**
 * HandoffService unit test — the runtime-owned per-room handoff store.
 *
 * Mirrors the LifeOps room-policy contract: enter flips the room into handoff
 * mode, status() reflects it, exit() clears it; plus the pure resume-evaluation
 * helpers re-exported from the store. Exercised through the registered service's
 * `getStore()` accessor.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { createMockRuntime } from "@elizaos/core/testing";
import { describe, expect, it } from "vitest";
import {
  HANDOFF_SERVICE,
  HandoffService,
  resolveHandoffService,
} from "./service.ts";
import { evaluateResume } from "./store.ts";

function makeRuntime(): IAgentRuntime {
  const cache = new Map<string, unknown>();
  return {
    agentId: "test-agent",
    async getCache<T>(key: string): Promise<T | null> {
      const value = cache.get(key);
      return value === undefined ? null : (value as T);
    },
    async setCache<T>(key: string, value: T): Promise<boolean> {
      cache.set(key, value);
      return true;
    },
    async deleteCache(key: string): Promise<boolean> {
      return cache.delete(key);
    },
  } as unknown as IAgentRuntime;
}

describe("HandoffService", () => {
  it("exposes the canonical serviceType literal", () => {
    expect(HandoffService.serviceType).toBe("eliza_handoff");
    expect(HANDOFF_SERVICE).toBe("eliza_handoff");
  });

  it("enter + status + exit lifecycle works through the service store", async () => {
    const runtime = makeRuntime();
    const service = await HandoffService.start(runtime);
    const store = service.getStore();
    const roomId = "room-handoff-1";

    expect((await store.status(roomId)).active).toBe(false);

    await store.enter(roomId, {
      reason: "handing the thread to the human",
      resumeOn: { kind: "mention" },
    });
    const status = await store.status(roomId);
    expect(status.active).toBe(true);
    expect(status.reason).toBe("handing the thread to the human");
    expect(status.resumeOn?.kind).toBe("mention");

    // The pure resume helper re-exported through the agent store.
    expect(evaluateResume({ status, mentionsAgent: true }).shouldResume).toBe(
      true,
    );
    expect(evaluateResume({ status, mentionsAgent: false }).shouldResume).toBe(
      false,
    );

    await store.exit(roomId);
    expect((await store.status(roomId)).active).toBe(false);

    await service.stop();
  });

  it("resolveHandoffService returns null when unregistered", () => {
    const runtime = createMockRuntime({
      getService: () => null,
    });
    expect(resolveHandoffService(runtime)).toBeNull();
  });
});
