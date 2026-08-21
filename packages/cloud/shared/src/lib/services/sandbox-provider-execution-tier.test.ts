/**
 * Exercises the three sandbox provider boundaries with deterministic tripwire
 * configs so invalid placement authority is rejected before any allocation.
 */

import { describe, expect, test } from "bun:test";
import { CONTAINER_BACKED_EXECUTION_TIERS } from "../../db/schemas/agent-sandboxes";
import { DockerSandboxProvider } from "./docker-sandbox-provider";
import { LocalDockerSandboxProvider } from "./local-docker-sandbox-provider";
import { MemorySandboxProvider } from "./memory-sandbox-provider";
import {
  assertContainerBackedExecutionTier,
  type SandboxCreateConfig,
  type SandboxProvider,
} from "./sandbox-provider-types";

const CONTAINER_TIERS = ["dedicated-lazy", "dedicated-always", "custom"] as const;
const INVALID_TIERS: ReadonlyArray<{ name: string; value: unknown }> = [
  { name: "shared", value: "shared" },
  { name: "unknown", value: "future-container-tier" },
  { name: "corrupt", value: { tier: "dedicated-always" } },
  { name: "missing", value: undefined },
];

const PROVIDERS: ReadonlyArray<{ name: string; create: () => SandboxProvider }> = [
  { name: "remote Docker", create: () => new DockerSandboxProvider() },
  { name: "local Docker", create: () => new LocalDockerSandboxProvider() },
  { name: "memory", create: () => new MemorySandboxProvider() },
];

function tripwireConfig(executionTier: unknown, unexpectedReads: string[]): SandboxCreateConfig {
  return new Proxy({ executionTier } as unknown as SandboxCreateConfig, {
    get(target, property, receiver) {
      if (property === "executionTier") return executionTier;
      unexpectedReads.push(String(property));
      return Reflect.get(target, property, receiver);
    },
  });
}

describe("sandbox provider execution-tier admission", () => {
  test("accepts every explicitly container-backed tier", () => {
    expect(CONTAINER_BACKED_EXECUTION_TIERS).toEqual(CONTAINER_TIERS);
    for (const tier of CONTAINER_TIERS) {
      expect(() => assertContainerBackedExecutionTier(tier)).not.toThrow();
    }
  });

  for (const providerCase of PROVIDERS) {
    for (const tierCase of INVALID_TIERS) {
      test(`${providerCase.name} rejects ${tierCase.name} before reading allocation inputs`, async () => {
        const unexpectedReads: string[] = [];
        const provider = providerCase.create();

        await expect(
          provider.create(tripwireConfig(tierCase.value, unexpectedReads)),
        ).rejects.toMatchObject({
          code: "SANDBOX_CREATE_EXECUTION_TIER_NOT_CONTAINER_BACKED",
        });
        expect(unexpectedReads).toEqual([]);
      });
    }
  }
});
