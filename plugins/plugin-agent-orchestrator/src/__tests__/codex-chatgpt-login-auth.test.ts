/**
 * Codex subscription detection against the auth.json shape a ChatGPT login
 * writes: `OPENAI_API_KEY` is null and the OAuth state lives under `tokens`
 * (the same record packages/auth's coding-account bridge materializes). The
 * ACP preflight reports Codex auth as "unknown", so this file read is the only
 * subscription signal the planner providers and the settings route get.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime, Memory, State, UUID } from "@elizaos/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { codingAgentExamplesProvider } from "../providers/action-examples.js";
import {
  clearTaskAgentFrameworkStateCache,
  getTaskAgentFrameworkState,
} from "../services/task-agent-frameworks.js";
import { createRealTestRuntime } from "./real-runtime.js";

const ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "ELIZA_CONFIG_PATH",
  "ELIZA_LLM_PROVIDER",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
] as const;

describe("Codex ChatGPT login detection", () => {
  let runtime: AgentRuntime;
  let cleanup: (() => Promise<void>) | undefined;
  let home: string;
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

  function writeCodexAuth(auth: Record<string, unknown>): void {
    writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify(auth));
  }

  beforeAll(async () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    home = mkdtempSync(join(tmpdir(), "codex-chatgpt-login-"));
    mkdirSync(join(home, ".codex"), { recursive: true });
    process.env.HOME = home;
    delete process.env.USERPROFILE;
    process.env.ELIZA_CONFIG_PATH = join(home, "missing-eliza.json");
    delete process.env.ELIZA_LLM_PROVIDER;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_API_KEY;
    ({ runtime, cleanup } = await createRealTestRuntime({
      characterName: "codex-chatgpt-login",
    }));
  }, 60_000);

  beforeEach(() => {
    clearTaskAgentFrameworkStateCache();
  });

  afterAll(async () => {
    await cleanup?.();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("tells the planner a ChatGPT-logged-in Codex uses the user's subscription", async () => {
    writeCodexAuth({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: "header.payload.signature",
        access_token: "chatgpt-access-token",
        refresh_token: "chatgpt-refresh-token",
        account_id: "acct-1",
      },
      last_refresh: "2026-11-07T00:00:00.000Z",
    });

    const message = {
      entityId: "00000000-0000-4000-8000-0000000000e1" as UUID,
      roomId: "00000000-0000-4000-8000-0000000000e2" as UUID,
      content: { text: "fix the failing login test in my repo" },
    } satisfies Memory;
    const providerState: State = { values: {}, data: {}, text: "" };
    const result = await codingAgentExamplesProvider.get(
      runtime,
      message,
      providerState,
    );
    const codexLine = String(result.values?.taskAgentExamples)
      .split("\n")
      .find((line) => line.startsWith("- Codex:"));
    expect(codexLine).toContain("uses the user's subscription");
    expect(codexLine).toContain("ready to use the user's OpenAI subscription");

    const state = await getTaskAgentFrameworkState(runtime);
    const codex = state.frameworks.find((f) => f.id === "codex");
    expect(codex?.subscriptionReady).toBe(true);
  });

  it("does not count a login file without an access token", async () => {
    writeCodexAuth({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: { refresh_token: "chatgpt-refresh-token" },
    });

    const state = await getTaskAgentFrameworkState(runtime);
    const codex = state.frameworks.find((f) => f.id === "codex");
    expect(codex?.subscriptionReady).toBe(false);
  });
});
