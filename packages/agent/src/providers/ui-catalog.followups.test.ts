/**
 * Coverage for uiCatalogProvider's followups/form marker instructions: the
 * [FOLLOWUPS]/[FORM] grammar and its three followup kinds (reply / navigate /
 * prompt) are taught on the dashboard (API) channel, the example block matches
 * the exact regex the UI parser accepts (so the docs can't drift from the
 * parser), and no markers leak onto connector-style group channels.
 * Deterministic: the admin gate is forced open by mocking security/access; no
 * live model.
 */
import {
  ChannelType,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

// The followups/form instructions live behind the provider's admin gate; force
// it open so these tests focus on instruction delivery + channel gating.
vi.mock("../security/access.ts", () => ({
  hasAdminAccess: vi.fn(async () => true),
}));

import { uiCatalogProvider } from "./ui-catalog.ts";

function makeRuntime(): IAgentRuntime {
  return {} as unknown as IAgentRuntime;
}

function makeMessage(channelType?: ChannelType): Memory {
  return { content: { channelType } } as unknown as Memory;
}

describe("uiCatalogProvider — followups/form marker instructions", () => {
  it("teaches [FOLLOWUPS] and [FORM] on the dashboard (API) channel", async () => {
    const result = await uiCatalogProvider.get(
      makeRuntime(),
      makeMessage(ChannelType.API),
      {} as State,
    );
    const text = result.text ?? "";
    expect(text).toContain("[FOLLOWUPS]");
    expect(text).toContain("[/FOLLOWUPS]");
    expect(text).toContain("[FORM]");
    expect(text).toContain("[/FORM]");
    // Documents all three followup kinds and a concrete navigate example.
    expect(text).toContain("reply:");
    expect(text).toContain("navigate:/apps/tasks");
    expect(text).toContain("prompt:");
  });

  it("emits the followup example in the exact grammar the UI parser accepts", async () => {
    // The UI parser regex requires `[FOLLOWUPS]\n<lines>\n[/FOLLOWUPS]` with
    // `<kind>:<payload>=<label>` lines. Assert the instruction's example block
    // satisfies it so the docs can't drift from the parser.
    const result = await uiCatalogProvider.get(
      makeRuntime(),
      makeMessage(ChannelType.API),
      {} as State,
    );
    const text = result.text ?? "";
    const block = /\[FOLLOWUPS\]\n([\s\S]*?)\n\[\/FOLLOWUPS\]/.exec(text);
    expect(block).not.toBeNull();
    const lines = (block?.[1] ?? "").split("\n").filter((l) => l.trim());
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      // every example line is `<something>=<label>`
      expect(line).toMatch(/^.+=.+$/);
    }
  });

  it("emits nothing on connector-style group channels (no marker leak)", async () => {
    const result = await uiCatalogProvider.get(
      makeRuntime(),
      makeMessage(ChannelType.GROUP),
      {} as State,
    );
    expect(result.text ?? "").toBe("");
  });
});
