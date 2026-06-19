import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import undesirablePlugin, { loadWorkspace } from "./index";

function runtime(agentId: string, settings: Record<string, string | undefined> = {}): IAgentRuntime {
  return {
    agentId,
    generateText: vi.fn(async () => "model response"),
    getSetting: (key: string) => settings[key],
  } as unknown as IAgentRuntime;
}

function message(text: string): Memory {
  return { content: { text } } as Memory;
}

describe("Undesirables workspace loading", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), "undesirables-workspace-"));
    mkdirSync(path.join(workspace, "skills"));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("loads soul files, sanitized frontmatter, malformed prediction fallback, and skills", async () => {
    writeFileSync(
      path.join(workspace, "SOUL.md"),
      `---
name: Holder Soul
archetype: The Analyst
__proto__:
  polluted: true
constructor: nope
---
# Holder Soul`,
    );
    writeFileSync(path.join(workspace, "SYSTEM_PROMPT.txt"), "system prompt");
    writeFileSync(path.join(workspace, "MEMORY.md"), "memory entry");
    writeFileSync(path.join(workspace, "PREDICTIONS_LEDGER.json"), "{ not json");
    writeFileSync(path.join(workspace, "skills", "market_analysis.md"), "skill text");

    const loaded = await loadWorkspace(workspace);

    expect(loaded.systemPrompt).toBe("system prompt");
    expect(loaded.memory).toBe("memory entry");
    expect(loaded.predictions).toEqual([]);
    expect(loaded.skills).toEqual({ market_analysis: "skill text" });
    expect(loaded.meta).toMatchObject({
      name: "Holder Soul",
      archetype: "The Analyst",
    });
    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(loaded.meta).not.toHaveProperty("__proto__");
    expect(loaded.meta).not.toHaveProperty("constructor");
  });

  it("rejects skill symlinks that escape the workspace", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "undesirables-outside-"));
    writeFileSync(path.join(workspace, "SOUL.md"), "# Soul");
    writeFileSync(path.join(outside, "escape.md"), "outside");
    symlinkSync(path.join(outside, "escape.md"), path.join(workspace, "skills", "escape.md"));

    await expect(loadWorkspace(workspace)).rejects.toThrow("Symlink traversal detected");

    rmSync(outside, { recursive: true, force: true });
  });
});

describe("Undesirables action behavior", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), "undesirables-action-"));
    mkdirSync(path.join(workspace, "skills"));
    writeFileSync(
      path.join(workspace, "SOUL.md"),
      `---
name: Holder Soul
archetype: The Analyst
strategy: Measured
token_id: "42"
adjectives: [direct, skeptical]
---
# Holder Soul`,
    );
    writeFileSync(path.join(workspace, "skills", "market_analysis.md"), "Analyze markets carefully.");
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("loads a holder workspace through the soul provider and wraps skill text as untrusted action context", async () => {
    const testRuntime = runtime("agent-action", { UNDESIRABLES_WORKSPACE: workspace });
    const provider = undesirablePlugin.providers?.find((entry) => entry.name === "undesirables-soul");
    const action = undesirablePlugin.actions?.find(
      (entry) => entry.name === "UNDESIRABLE_MARKET_ANALYSIS",
    );
    const callback = vi.fn();

    expect(provider).toBeDefined();
    expect(action).toBeDefined();
    const providerResult = await provider?.get(testRuntime, message("load soul"), {} as never);

    expect(providerResult?.values).toMatchObject({
      soulName: "Holder Soul",
      isDemo: false,
    });
    await expect(action?.validate?.(testRuntime, message("Analyze ETH"))).resolves.toBe(true);
    await expect(
      action?.handler?.(testRuntime, message("Analyze ETH"), undefined, undefined, callback),
    ).resolves.toMatchObject({
      success: true,
      text: "model response",
    });

    expect(testRuntime.generateText).toHaveBeenCalledWith(
      expect.stringContaining("<untrusted_skill_data>\nAnalyze markets carefully.\n</untrusted_skill_data>"),
    );
    expect(callback).toHaveBeenCalledWith(
      { text: "model response", source: "plugin-undesirables" },
      "UNDESIRABLE_MARKET_ANALYSIS",
    );
  });
});
