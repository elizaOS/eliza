/** Tests boot-time creation and reuse of the optimized-prompt integrity key. */

import { describe, expect, it, vi } from "vitest";
import { resolveOptimizedPromptIntegrityKey } from "./vault-bridge.ts";

describe("resolveOptimizedPromptIntegrityKey", () => {
  it("persists one sensitive 256-bit key", async () => {
    const values = new Map<string, string>();
    const vault = {
      has: vi.fn(async (key: string) => values.has(key)),
      get: vi.fn(async (key: string) => {
        const value = values.get(key);
        if (!value) throw new Error("missing");
        return value;
      }),
      setIfAbsent: vi.fn(
        async (key: string, value: string): Promise<boolean> => {
          if (values.has(key)) return false;
          values.set(key, value);
          return true;
        },
      ),
    };

    const first = await resolveOptimizedPromptIntegrityKey(vault);
    const second = await resolveOptimizedPromptIntegrityKey(vault);

    expect(Buffer.from(first, "base64")).toHaveLength(32);
    expect(second).toBe(first);
    expect(vault.setIfAbsent).toHaveBeenCalledOnce();
    expect(vault.setIfAbsent).toHaveBeenCalledWith(
      "system.optimized-prompt.hmac-key",
      first,
      { sensitive: true, caller: "runtime-boot" },
    );
  });

  it("uses the winner when another process creates the key first", async () => {
    const winner = Buffer.alloc(32, 7).toString("base64");
    const vault = {
      has: vi.fn(async () => false),
      get: vi.fn(async () => winner),
      setIfAbsent: vi.fn(async () => false),
    };

    expect(await resolveOptimizedPromptIntegrityKey(vault)).toBe(winner);
    expect(vault.get).toHaveBeenCalledOnce();
  });
});
