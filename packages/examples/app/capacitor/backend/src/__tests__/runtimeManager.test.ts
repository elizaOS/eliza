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

describe("capacitor backend runtimeManager", () => {
  let dataDir = "";

  beforeEach(async () => {
    dataDir = await makeTempDir("eliza-capacitor-");
    process.env.LOCALDB_DATA_DIR = dataDir;
    await __shutdownForTests();
  });

  afterEach(async () => {
    await __shutdownForTests();
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("creates a runtime with a messageService", async () => {
    const bundle = await getOrCreateRuntime(DEFAULT_CONFIG);
    expect(bundle.runtime.messageService).not.toBeNull();
  });

  it("falls back to elizaClassic when credentials missing", async () => {
    const cfg: AppConfig = {
      ...DEFAULT_CONFIG,
      mode: "openai",
      provider: { ...DEFAULT_CONFIG.provider, openaiApiKey: "" },
    };

    const { effectiveMode, responseText } = await sendMessage(cfg, "hello");
    expect(effectiveMode).toBe("elizaClassic");
    expect(responseText.trim().length).toBeGreaterThan(0);
  });

  it("produces a response and persists both user+assistant messages", async () => {
    await resetConversation(DEFAULT_CONFIG);
    const { responseText, effectiveMode } = await sendMessage(
      DEFAULT_CONFIG,
      "Hello, I'm feeling anxious today.",
    );

    expect(effectiveMode).toBe("elizaClassic");
    expect(responseText.trim().length).toBeGreaterThan(0);

    const history = await getHistory(DEFAULT_CONFIG);
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history.some((m) => m.role === "user")).toBe(true);
    expect(history.some((m) => m.role === "assistant")).toBe(true);

    const last = history[history.length - 1];
    expect(last.role).toBe("assistant");
    expect(last.text.trim().length).toBeGreaterThan(0);
  });
});

