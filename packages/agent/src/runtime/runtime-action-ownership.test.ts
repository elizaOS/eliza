/**
 * Verifies known host fallback overlaps are deduplicated while unrelated
 * plugin collisions remain visible to core's normal warning policy.
 */
import type { Action, IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { registerFallbackActionIfAbsent } from "./runtime-action-ownership.ts";

function action(name: string): Action {
  return {
    name,
    description: name,
    validate: async () => true,
    handler: async () => ({ success: true }),
    examples: [],
  };
}

describe("runtime action ownership", () => {
  it("registers fallback web actions only when no plugin owns the name", () => {
    const registerAction = vi.fn();
    const existing = action("WEB_FETCH");
    const runtime = {
      actions: [existing],
      registerAction,
    } as unknown as Pick<IAgentRuntime, "actions" | "registerAction">;

    expect(registerFallbackActionIfAbsent(runtime, action("WEB_FETCH"))).toBe(
      false,
    );
    expect(registerAction).not.toHaveBeenCalled();

    expect(registerFallbackActionIfAbsent(runtime, action("WEB_SEARCH"))).toBe(
      true,
    );
    expect(registerAction).toHaveBeenCalledOnce();
  });
});
