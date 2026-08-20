/**
 * Verifies the Shared capability provider is synchronous-edge-safe in effect
 * and that its upgrade action never mutates or activates Dedicated compute.
 */

import { describe, expect, test } from "bun:test";
import {
  createRequestDedicatedUpgradeAction,
  createSharedRuntimeCapabilitiesProvider,
  REQUEST_DEDICATED_UPGRADE_ACTION,
  SHARED_RUNTIME_PLUGIN_COMPATIBILITY,
} from "./shared-runtime-capabilities";

describe("Shared runtime capability components", () => {
  test("audits every first-party plugin with an explicit edge entrypoint", () => {
    expect(SHARED_RUNTIME_PLUGIN_COMPATIBILITY.map(({ plugin }) => plugin)).toEqual(
      expect.arrayContaining([
        "@elizaos/core/edge",
        "@elizaos/plugin-web-search/edge",
        "@elizaos/plugin-scheduling/edge",
        "@elizaos/plugin-todos/edge",
      ]),
    );
  });

  test("provides complete capability context well below the provider budget", async () => {
    const provider = createSharedRuntimeCapabilitiesProvider({
      agentId: "personal:user-1",
      webSearch: true,
      reminders: true,
      todos: false,
      media: false,
    });
    const startedAt = performance.now();
    const result = await provider.get({} as never, {} as never);
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(25);
    expect(result.data).toMatchObject({
      runtimeMode: "shared",
      available: [
        "conversation and reasoning",
        "conversation memory",
        "public web search",
        "private reminders",
      ],
      canActivateDedicatedWithoutConfirmation: false,
    });
    expect(result.text).toContain(REQUEST_DEDICATED_UPGRADE_ACTION);
  });

  test("returns a structured review handoff for an in-character continuation", async () => {
    const action = createRequestDedicatedUpgradeAction("personal:user/1");
    const delivered: string[] = [];
    const result = await action.handler(
      {} as never,
      {} as never,
      undefined,
      { parameters: { capability: "coding" } },
      async (content) => {
        delivered.push(content.text ?? "");
        return [];
      },
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      upgradePath: "/cloud/agents/personal%3Auser%2F1",
      mutationPerformed: false,
      requiresUserConfirmation: true,
    });
    expect(result.text).toContain("no mutation or charge was performed");
    expect(delivered).toEqual([]);
    expect(action.suppressPostActionContinuation).not.toBe(true);
  });
});
