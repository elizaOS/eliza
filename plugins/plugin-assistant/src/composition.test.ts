/** Real registry boundary: an empty kernel and an explicitly supplied assistant. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantPlugin } from "./index.ts";
import { getAssistantPromptBatcher } from "./runtime/assistant-reasoning.ts";

let stateDirectory: string;
const runtimes: AgentRuntime[] = [];
beforeEach(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), "eliza-composition-"));
  vi.stubEnv("ELIZA_STATE_DIR", stateDirectory);
});
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  vi.unstubAllEnvs();
  await rm(stateDirectory, { recursive: true, force: true });
});

describe("explicit assistant composition", () => {
  it("boots core without conversational behavior or a message service", async () => {
    const runtime = new AgentRuntime({
      character: { name: "kernel", bio: "kernel" },
      logLevel: "fatal",
    });
    runtimes.push(runtime);
    vi.stubEnv("PROMPT_BATCHER_BATCH_SIZE", "invalid-unused-setting");
    await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
    expect(runtime.actions).toEqual([]);
    expect(runtime.providers).toEqual([]);
    expect(runtime.messageService).toBeNull();
    expect(runtime.contexts.list()).toEqual([]);
    await expect(
      runtime.dynamicPromptExecFromState({
        params: { prompt: "Return a value" },
        schema: [{ field: "value", required: true }],
      }),
    ).rejects.toThrow("registered executor");
    expect(runtime.getTaskWorker("BATCHER_DRAIN")).toBeUndefined();
    expect(getAssistantPromptBatcher(runtime)).toBeUndefined();
  });

  it("registers one assistant contribution and releases its message service on unload", async () => {
    const runtime = new AgentRuntime({
      character: { name: "assistant", bio: "assistant" },
      logLevel: "fatal",
    });
    runtimes.push(runtime);
    await runtime.registerPlugin(createAssistantPlugin());
    expect(runtime.actions.some((action) => action.name === "REPLY")).toBe(
      true,
    );
    expect(runtime.actions.some((action) => action.name === "ROLE")).toBe(true);
    expect(runtime.messageService).not.toBeNull();
    expect(
      runtime.providers.some((provider) => provider.name === "CONTEXT_BENCH"),
    ).toBe(false);
    expect(runtime.contexts.list().length).toBeGreaterThan(0);
    const batcher = getAssistantPromptBatcher(runtime);
    expect(runtime.getTaskWorker("BATCHER_DRAIN")).toBeDefined();
    await runtime.unloadPlugin("assistant");
    expect(runtime.getTaskWorker("BATCHER_DRAIN")).toBeUndefined();
    expect(getAssistantPromptBatcher(runtime)).toBeUndefined();
    await expect(
      batcher?.addSection({
        id: "late-work",
        preamble: "late",
        schema: [],
        frequency: "once",
      }),
    ).rejects.toThrow("disposed");
    expect(runtime.messageService).toBeNull();
    await expect(
      runtime.dynamicPromptExecFromState({
        params: { prompt: "Late request" },
        schema: [{ field: "value", required: true }],
      }),
    ).rejects.toThrow("registered executor");
    expect(runtime.actions).toEqual([]);
  });
});
