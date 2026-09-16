/** Real registry boundary: an empty kernel and an explicitly supplied assistant. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantPlugin } from "./index.ts";

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
    await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
    expect(runtime.actions).toEqual([]);
    expect(runtime.providers).toEqual([]);
    expect(runtime.messageService).toBeNull();
    expect(runtime.contexts.list()).toEqual([]);
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
    expect(runtime.contexts.list().length).toBeGreaterThan(0);
    await runtime.unloadPlugin("assistant");
    expect(runtime.messageService).toBeNull();
    expect(runtime.actions).toEqual([]);
  });
});
