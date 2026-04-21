import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type AppConfig } from "../types";
import {
  __shutdownForTests,
  getHistory,
  getOrCreateRuntime,
  resetConversation,
  sendMessage,
} from "../runtimeManager";

async function makeTempDir(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

describe("electron backend runtimeManager", () => {
  let dataDir = "";

  beforeEach(async () => {
    dataDir = await makeTempDir("eliza-electron-");
    await __shutdownForTests();
  });

  afterEach(async () => {
    await __shutdownForTests();
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("creates a runtime with a messageService", async () => {
    const bundle = await getOrCreateRuntime(DEFAULT_CONFIG, dataDir);
    expect(bundle.runtime.messageService).not.toBeNull();
  });

  it("falls back to elizaClassic when credentials missing", async () => {
    const cfg: AppConfig = {
      ...DEFAULT_CONFIG,
      mode: "openai",
      provider: { ...DEFAULT_CONFIG.provider, openaiApiKey: "" },
    };

    const { effectiveMode, responseText } = await sendMessage(cfg, "hello", dataDir);
    expect(effectiveMode).toBe("elizaClassic");
    expect(responseText.trim().length).toBeGreaterThan(0);
  });

  it("produces a response and persists both user+assistant messages", async () => {
    await resetConversation(DEFAULT_CONFIG, dataDir);
    const { responseText } = await sendMessage(
      DEFAULT_CONFIG,
      "Hello, I feel nervous.",
      dataDir,
    );

    expect(responseText.trim().length).toBeGreaterThan(0);

    const history = await getHistory(DEFAULT_CONFIG, dataDir);
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history.some((m) => m.role === "user")).toBe(true);
    expect(history.some((m) => m.role === "assistant")).toBe(true);
  });
});

