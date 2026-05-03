import { randomUUID } from "node:crypto";
import type { IAgentRuntime, Memory, State } from "@elizaos/core";

type TestRuntime = IAgentRuntime & {
  __services: Map<string, unknown>;
};

export function createUUID(): string {
  return randomUUID();
}

export function createTestMemory(
  partial: Partial<Memory> & { content?: Record<string, unknown> } = {}
): Memory {
  const base: Partial<Memory> = {
    id: createUUID(),
    entityId: createUUID(),
    roomId: createUUID(),
    content: { text: "" },
    createdAt: Date.now(),
  };

  return {
    ...base,
    ...partial,
    content: {
      ...(base.content as Record<string, unknown>),
      ...(partial.content ?? {}),
    },
  } as Memory;
}

export function createTestState(partial: Partial<State> = {}): State {
  return {
    values: {},
    data: {},
    text: "",
    ...partial,
  } as State;
}

export async function createTestRuntime(): Promise<IAgentRuntime> {
  const services = new Map<string, unknown>();

  const runtime: Partial<TestRuntime> = {
    agentId: createUUID(),
    __services: services,
    getService(name: string) {
      return services.get(name);
    },
    registerService(name: string, service: unknown) {
      services.set(name, service);
      return service;
    },
    getSetting() {
      return undefined;
    },
  };

  return runtime as IAgentRuntime;
}

export async function cleanupTestRuntime(runtime: IAgentRuntime): Promise<void> {
  const maybeRuntime = runtime as Partial<TestRuntime>;
  if (maybeRuntime.__services) {
    maybeRuntime.__services.clear();
  }
}
