import type { AgentRuntime } from "@elizaos/core";

/** Test double for subscriptions browser-flow tests — real impl lives alongside LifeOps mocks. */
export class FakeSubscriptionComputerUseService {
  constructor(public readonly fixtureId: string) {}
}

/** Registers the fake Computer Use service onto the runtime (no-op shim for Vitest bundles). */
export function attachFakeSubscriptionComputerUse(
  _runtime: AgentRuntime,
  _svc?: FakeSubscriptionComputerUseService,
): void {}
