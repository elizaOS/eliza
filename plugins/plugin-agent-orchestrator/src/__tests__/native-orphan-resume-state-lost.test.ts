/**
 * A native session that was busy when the runtime restarted has lost its
 * agent conversation: a reattach opens a new protocol session. The boot
 * orphan scan must report the state loss (so the router respawns the
 * original task) and must not send a contextless "continue" prompt whose
 * reply reads as the task result. Real AcpService and native transport with
 * the fake ACP agent subprocess.
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

function makeRuntime(): IAgentRuntime {
  return {
    agentId: "00000000-0000-4000-8000-00000000a7a7",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    reportError() {},
    getSetting: (k: string) => {
      if (k === "ELIZA_ACP_TRANSPORT") return "native";
      if (k === "ELIZA_ACP_DEFAULT_AGENT") return "elizaos";
      if (k === "ELIZA_ACP_NO_TERMINAL") return "true";
      if (k === "ELIZA_ACP_SESSION_STORE_BACKEND") return "memory";
      if (k === "ELIZA_ELIZAOS_ACP_COMMAND") return `node ${FAKE_AGENT}`;
      return process.env[k as keyof typeof process.env] as string | undefined;
    },
  } as never;
}

type Internals = {
  store: {
    get(id: string): Promise<{ status: string } | null>;
    updateStatus(id: string, status: string): Promise<void>;
  };
  nativeClients: Map<string, { close(): Promise<void> }>;
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("reports a busy native orphan as state lost instead of prompting a blank session", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "native-orphan-resume-"));
  cleanups.push(async () => rmSync(workdir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: workdir });

  // Spawn, mark the session mid-turn, then drop the live client the way a
  // restart does.
  const first = new AcpService(makeRuntime());
  await first.start();
  const spawned = await first.spawnSession({
    agentType: "elizaos",
    workdir,
    approvalPreset: "permissive",
  });
  const store = (first as unknown as Internals).store;
  await store.updateStatus(spawned.sessionId, "busy");
  const firstClients = (first as unknown as Internals).nativeClients;
  await firstClients.get(spawned.sessionId)?.close();
  firstClients.clear();
  await first.stop();

  const service = new AcpService(makeRuntime(), { store } as never);
  cleanups.push(() => service.stop().catch(() => undefined));
  await service.start();
  const events: Array<{ event: string; failureKind?: unknown }> = [];
  service.onSessionEvent((sessionId, event, data) => {
    if (sessionId !== spawned.sessionId) return;
    events.push({
      event,
      failureKind: (data as { failureKind?: unknown } | undefined)?.failureKind,
    });
  });

  await service.resumeOrphanedBusySessions();
  await new Promise((resolve) => setTimeout(resolve, 1500));

  expect((await store.get(spawned.sessionId))?.status).toBe("errored");
  expect(events).toContainEqual({
    event: "error",
    failureKind: "session_state_lost",
  });
  expect(events.some((e) => e.event === "task_complete")).toBe(false);
  // The fake agent writes its app files only when it runs a prompt.
  expect(existsSync(join(workdir, "index.html"))).toBe(false);
}, 60_000);
