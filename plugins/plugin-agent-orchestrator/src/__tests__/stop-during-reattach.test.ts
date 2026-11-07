/**
 * After a restart a native session has no live client, so the next prompt
 * reattaches lazily. A stop that lands while that reattach is still running
 * must stop the prompt: the agent must not run it, and the client the
 * reattach opened must be closed. Real AcpService and native transport with
 * the fake ACP agent subprocess (slow `initialize` holds the reattach open).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, expect, it } from "vitest";
import { AcpService } from "../services/acp-service.ts";

const FAKE_AGENT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "__tests__",
  "fixtures",
  "fake-acp-agent.mjs",
);

function makeRuntime(slowInitialize = false): IAgentRuntime {
  return {
    agentId: "00000000-0000-4000-8000-0000000057a7",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    reportError() {},
    getSetting: (k: string) => {
      if (k === "ELIZA_ACP_TRANSPORT") return "native";
      if (k === "ELIZA_ACP_DEFAULT_AGENT") return "elizaos";
      if (k === "ELIZA_ACP_NO_TERMINAL") return "true";
      if (k === "ELIZA_ACP_SESSION_STORE_BACKEND") return "memory";
      if (k === "ELIZA_ELIZAOS_ACP_COMMAND")
        return `node ${FAKE_AGENT}${slowInitialize ? " --slow-initialize" : ""}`;
      return process.env[k as keyof typeof process.env] as string | undefined;
    },
  } as never;
}

type Internals = {
  store: { get(id: string): Promise<{ status: string } | null> };
  nativeClients: Map<string, { close(): Promise<void> }>;
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("does not run a prompt whose session is stopped during the reattach", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "stop-during-reattach-"));
  cleanups.push(async () => rmSync(workdir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: workdir });

  // Spawn, then drop the live client the way a restart does.
  const first = new AcpService(makeRuntime());
  await first.start();
  const spawned = await first.spawnSession({
    agentType: "elizaos",
    workdir,
    approvalPreset: "permissive",
  });
  const store = (first as unknown as Internals).store;
  const firstClients = (first as unknown as Internals).nativeClients;
  await firstClients.get(spawned.sessionId)?.close();
  firstClients.clear();
  await first.stop();

  const service = new AcpService(makeRuntime(true), { store } as never);
  cleanups.push(() => service.stop().catch(() => undefined));
  await service.start();

  const prompt = service.sendPrompt(spawned.sessionId, "build the app");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await service.closeSession(spawned.sessionId);
  const result = await prompt;

  expect(result.stopReason).toBe("stopped");
  expect((await store.get(spawned.sessionId))?.status).toBe("stopped");
  expect(
    (service as unknown as Internals).nativeClients.has(spawned.sessionId),
  ).toBe(false);
  // The fake agent writes its app files only when it runs a prompt.
  expect(existsSync(join(workdir, "index.html"))).toBe(false);
}, 60_000);
