/** Real whitelist/confirmation handlers with an in-memory cache persistence port. */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { expect, it } from "vitest";
import { __internal, runAutofillHandler } from "./autofill.ts";

it.each([true, false])(
  "reports the saved whitelist truthfully after confirmation (write=%s)",
  async (writeAccepted) => {
    const cache = new Map<string, unknown>();
    const runtime = {
      agentId: "agent",
      getCache: async (key: string) => cache.get(key),
      setCache: async (key: string, value: unknown) => {
        if (key === __internal.WHITELIST_CACHE_KEY && !writeAccepted)
          return false;
        cache.set(key, value);
        return true;
      },
      deleteCache: async (key: string) => cache.delete(key),
    } as unknown as IAgentRuntime;
    const run = (text: string, domain = "example.org") =>
      runAutofillHandler(
        runtime,
        {
          entityId: "owner",
          roomId: "room",
          content: { text, source: "test" },
        } as Memory,
        undefined,
        { parameters: { action: "whitelist_add", domain } },
      );
    const pending = await run("Trust example.org for autofill");
    expect(pending.success).toBe(false);
    expect(pending.text).toContain("Reply yes to confirm or no to cancel");
    expect(cache.has(__internal.WHITELIST_CACHE_KEY)).toBe(false);
    const result = await run("yes");
    expect(result.success).toBe(writeAccepted);
    if (writeAccepted) {
      expect(cache.get(__internal.WHITELIST_CACHE_KEY)).toEqual([
        "example.org",
      ]);
      expect((await run("Trust example.org")).text).toContain(
        "already whitelisted",
      );
    } else {
      expect(result.text).toContain("could not save");
      expect(cache.has(__internal.WHITELIST_CACHE_KEY)).toBe(false);
      expect(result.data?.requiresConfirmation).toBeUndefined();
    }
    const next = await run("Trust another site", "example.net");
    expect(next.text).toContain("Reply yes");
    expect((await run("no", "example.net")).text).toContain("Cancelled");
  },
);
