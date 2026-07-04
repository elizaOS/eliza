/**
 * Covers notifyAction against a real NotificationService (in-memory cache + stub
 * event bus): validate gating, creating a notification from params, invalid
 * category/priority fallback, and failure on missing title or absent service.
 */
import type {
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { NotificationService, ServiceType } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { notifyAction } from "./notify";

async function makeRuntime(withService = true): Promise<{
  runtime: IAgentRuntime;
  service: NotificationService | null;
}> {
  const cache = new Map<string, unknown>();
  const bus = { emit: vi.fn() };
  const base = {
    agentId: "00000000-0000-0000-0000-0000000000aa",
    getCache: async <T>(k: string): Promise<T | undefined> =>
      cache.get(k) as T | undefined,
    setCache: async <T>(k: string, v: T): Promise<boolean> => {
      cache.set(k, v);
      return true;
    },
    deleteCache: async (k: string): Promise<boolean> => cache.delete(k),
    getService: (t: string) => (t === ServiceType.AGENT_EVENT ? bus : null),
  } as unknown as IAgentRuntime;
  const service = withService
    ? ((await NotificationService.start(base)) as NotificationService)
    : null;
  const runtime = {
    agentId: base.agentId,
    getService: (t: string) =>
      t === ServiceType.NOTIFICATION
        ? service
        : t === ServiceType.AGENT_EVENT
          ? bus
          : null,
  } as unknown as IAgentRuntime;
  return { runtime, service };
}

const message = {} as Memory;
const state = {} as State;

describe("notifyAction", () => {
  let runtime: IAgentRuntime;
  let service: NotificationService | null;

  beforeEach(async () => {
    ({ runtime, service } = await makeRuntime());
  });

  it("validates true only when the notification service exists", async () => {
    expect(await notifyAction.validate(runtime, message)).toBe(true);
    const { runtime: bare } = await makeRuntime(false);
    expect(await notifyAction.validate(bare, message)).toBe(false);
  });

  it("creates a notification from parameters", async () => {
    const callback = vi.fn() as unknown as HandlerCallback;
    const result = await notifyAction.handler(
      runtime,
      message,
      state,
      {
        parameters: {
          title: "Build done",
          body: "ok",
          category: "workflow",
          priority: "high",
        },
      },
      callback,
    );
    expect(result).toBeTruthy();
    expect((result as { success: boolean }).success).toBe(true);
    const list = service?.list() ?? [];
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("Build done");
    expect(list[0].category).toBe("workflow");
    expect(list[0].priority).toBe("high");
    expect(callback).toHaveBeenCalled();
  });

  it("falls back to defaults for invalid category/priority", async () => {
    await notifyAction.handler(
      runtime,
      message,
      state,
      { parameters: { title: "X", category: "nonsense", priority: "louder" } },
      undefined,
    );
    const list = service?.list() ?? [];
    expect(list[0].category).toBe("general");
    expect(list[0].priority).toBe("normal");
  });

  it("fails when title is missing", async () => {
    const result = await notifyAction.handler(
      runtime,
      message,
      state,
      { parameters: { body: "no title" } },
      undefined,
    );
    expect((result as { success: boolean }).success).toBe(false);
    expect(service?.list()).toHaveLength(0);
  });

  it("fails gracefully when the service is unavailable", async () => {
    const { runtime: bare } = await makeRuntime(false);
    const result = await notifyAction.handler(
      bare,
      message,
      state,
      { parameters: { title: "x" } },
      undefined,
    );
    expect((result as { success: boolean }).success).toBe(false);
  });
});
