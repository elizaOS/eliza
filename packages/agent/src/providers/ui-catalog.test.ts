/**
 * Coverage for the split UI-guide providers (#14324). Asserts the common marker
 * path (`uiWidgetsProvider`) leads with the closed marker vocabulary and no
 * longer carries the GenUI JSONL method or the full component catalog, that the
 * heavy generative guide (`uiGenerativeProvider`) is a separate provider gated
 * on its own visualisation keywords, that both keep the DM/API channel gate, and
 * that the marker path stays materially smaller than the pre-split guide via an
 * enforced size ceiling. Deterministic: the admin gate is forced open by mocking
 * security/access; no live model.
 */
import {
  ChannelType,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

// The guides live behind the providers' admin gate; force it open so these
// tests focus on content, ordering, channel gating, and relevance keywords.
vi.mock("../security/access.ts", () => ({
  hasAdminAccess: vi.fn(async () => true),
}));

import { uiGenerativeProvider, uiWidgetsProvider } from "./ui-catalog.ts";

function makeRuntime(): IAgentRuntime {
  return {} as unknown as IAgentRuntime;
}

function makeMessage(channelType?: ChannelType): Memory {
  return { content: { channelType } } as unknown as Memory;
}

async function widgetsText(
  channelType: ChannelType = ChannelType.API,
): Promise<string> {
  const result = await uiWidgetsProvider.get(
    makeRuntime(),
    makeMessage(channelType),
    {} as State,
  );
  return result.text ?? "";
}

async function generativeText(
  channelType: ChannelType = ChannelType.API,
): Promise<string> {
  const result = await uiGenerativeProvider.get(
    makeRuntime(),
    makeMessage(channelType),
    {} as State,
  );
  return result.text ?? "";
}

describe("uiWidgetsProvider — marker vocabulary (common path)", () => {
  it("leads with the marker vocabulary and omits the GenUI JSONL method + catalog", async () => {
    const text = await widgetsText();

    // Marker vocabulary the MVP relies on is all present.
    expect(text).toContain("[CONFIG:pluginId]");
    expect(text).toContain("[FORM]");
    expect(text).toContain("[/FORM]");
    expect(text).toContain("[FOLLOWUPS]");
    expect(text).toContain("[/FOLLOWUPS]");
    expect(text).toContain("[CHECKLIST]");
    expect(text).toContain("[WORKFLOW]");

    // The [CONFIG] marker leads — it appears before the generative escape-hatch
    // mention, so the common path does not steer the model toward raw JSONL.
    const configIdx = text.indexOf("[CONFIG:pluginId]");
    const generativeMentionIdx = text.indexOf("generative UI");
    expect(configIdx).toBeGreaterThan(-1);
    expect(configIdx).toBeLessThan(generativeMentionIdx);

    // The heavy GenUI method and the full catalog do NOT leak onto this path.
    expect(text).not.toMatch(/RFC 6902/);
    expect(text).not.toMatch(/JSON patch lines INLINE/);
    expect(text).not.toContain("Available components");
    expect(text).not.toContain('"op":"add"');
  });

  it("teaches followup grammar that the UI parser accepts", async () => {
    const text = await widgetsText();
    const block = /\[FOLLOWUPS\]\n([\s\S]*?)\n\[\/FOLLOWUPS\]/.exec(text);
    expect(block).not.toBeNull();
    const lines = (block?.[1] ?? "").split("\n").filter((l) => l.trim());
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^.+=.+$/);
    }
    expect(text).toContain("reply:");
    expect(text).toContain("navigate:/apps/tasks");
    expect(text).toContain("prompt:");
  });

  it("teaches [FORM]/[CHECKLIST]/[WORKFLOW] example bodies the UI parsers accept", async () => {
    const text = await widgetsText();

    const form = /\[FORM\]\n([\s\S]*?)\n\[\/FORM\]/.exec(text);
    expect(form).not.toBeNull();
    const formBody = JSON.parse(form?.[1] ?? "null") as {
      fields: Array<{ name: string; type: string }>;
    };
    expect(Array.isArray(formBody.fields)).toBe(true);
    expect(formBody.fields.length).toBeGreaterThan(0);

    const checklist = /\[CHECKLIST\]\n([\s\S]*?)\n\[\/CHECKLIST\]/.exec(text);
    expect(checklist).not.toBeNull();
    const checklistBody = JSON.parse(checklist?.[1] ?? "null") as {
      items: Array<{ content: string; status: string }>;
    };
    expect(Array.isArray(checklistBody.items)).toBe(true);
    for (const item of checklistBody.items) {
      expect(["pending", "in_progress", "completed"]).toContain(item.status);
    }

    const workflow = /\[WORKFLOW\]\n([\s\S]*?)\n\[\/WORKFLOW\]/.exec(text);
    expect(workflow).not.toBeNull();
    const workflowBody = JSON.parse(workflow?.[1] ?? "null") as {
      steps: Array<{ label: string; status: string }>;
    };
    expect(Array.isArray(workflowBody.steps)).toBe(true);
    for (const step of workflowBody.steps) {
      expect(["pending", "running", "done", "failed"]).toContain(step.status);
    }
  });

  it("keeps the marker path materially smaller than the pre-split guide", async () => {
    const text = await widgetsText();
    // Pre-split the combined guide was 138 lines / ~9.9k chars. The marker path
    // must stay well under that; this ceiling stops the guide silently regrowing.
    const lineCount = text.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(60);
    expect(text.length).toBeLessThanOrEqual(5000);
  });

  it("emits nothing on connector-style group channels (no marker leak)", async () => {
    expect(await widgetsText(ChannelType.GROUP)).toBe("");
  });
});

describe("uiGenerativeProvider — generative UI escape hatch", () => {
  it("carries the JSONL method and the full component catalog", async () => {
    const text = await generativeText();
    expect(text).toContain("RFC 6902");
    expect(text).toContain('{"op":"add","path":"/root"');
    expect(text).toContain("Available components");
  });

  it("does not restate the marker widgets it defers to", async () => {
    const text = await generativeText();
    expect(text).not.toContain("[CONFIG:pluginId]");
    expect(text).not.toContain("[FOLLOWUPS]");
  });

  it("emits nothing on connector-style group channels", async () => {
    expect(await generativeText(ChannelType.GROUP)).toBe("");
  });
});

describe("relevance keyword separation", () => {
  it("fires uiWidgets on plugin-setup intent, not uiGenerative", () => {
    // "set up discord" → marker path only.
    expect(uiWidgetsProvider.relevanceKeywords).toContain("discord");
    expect(uiWidgetsProvider.relevanceKeywords).toContain("setup");
    expect(uiGenerativeProvider.relevanceKeywords).not.toContain("discord");
    expect(uiGenerativeProvider.relevanceKeywords).not.toContain("setup");
  });

  it("fires uiGenerative on visualisation intent, not on plugin config", () => {
    // "show me a table of my week" → generative path reachable.
    expect(uiGenerativeProvider.relevanceKeywords).toContain("dashboard");
    expect(uiGenerativeProvider.relevanceKeywords).toContain("table");
    expect(uiGenerativeProvider.relevanceKeywords).toContain("chart");
    expect(uiWidgetsProvider.relevanceKeywords).not.toContain("dashboard");
  });

  it("both providers stay dynamic + agent-cached + ADMIN-gated", () => {
    for (const provider of [uiWidgetsProvider, uiGenerativeProvider]) {
      expect(provider.dynamic).toBe(true);
      expect(provider.cacheStable).toBe(true);
      expect(provider.cacheScope).toBe("agent");
      expect(provider.roleGate).toEqual({ minRole: "ADMIN" });
      expect(provider.relevanceKeywords?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
