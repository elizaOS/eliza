/**
 * Background initial-task prompt timeout: unit-checks the pure mapping helper
 * AND drives the real AcpService spawn path (fake ACP agent subprocess, real
 * native transport) to prove the wiring actually detaches an initial task from
 * the chat-turn timeout (timeoutMs 0) while honoring explicit caller timeouts.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AcpService,
  resolveInitialTaskPromptTimeoutMs,
} from "../services/acp-service.ts";

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
    agentId: "00000000-0000-4000-8000-00000000t1m3",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    getSetting: (k: string) => {
      if (k === "ELIZA_ACP_TRANSPORT") return "native";
      if (k === "ELIZA_ACP_DEFAULT_AGENT") return "elizaos";
      if (k === "ELIZA_ACP_NO_TERMINAL") return "true";
      if (k === "ELIZA_ELIZAOS_ACP_COMMAND") return `node ${FAKE_AGENT}`;
      return process.env[k as keyof typeof process.env] as string | undefined;
    },
  } as never;
}

describe("resolveInitialTaskPromptTimeoutMs (pure mapping)", () => {
  it("maps an absent explicit timeout to 0 (detached)", () => {
    expect(resolveInitialTaskPromptTimeoutMs(undefined)).toBe(0);
  });

  it("preserves explicit caller timeouts", () => {
    expect(resolveInitialTaskPromptTimeoutMs(120_000)).toBe(120_000);
  });
});

describe("initial-task spawn path applies the detached timeout (real AcpService + fake ACP agent)", () => {
  let workdir: string;
  let service: AcpService;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "initial-task-timeout-"));
    execFileSync("git", ["init", "-q"], { cwd: workdir });
    service = new AcpService(makeRuntime());
  });
  afterEach(async () => {
    await service.stop().catch(() => {});
    rmSync(workdir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it.each(["closeSession", "stop"] as const)(
    "%s waits for an in-flight native transport close",
    async (operation) => {
      await service.start();
      const spawned = await service.spawnSession({
        agentType: "elizaos",
        workdir,
        approvalPreset: "permissive",
      });
      const clients = (
        service as unknown as {
          nativeClients: Map<string, { close(): Promise<void> }>;
        }
      ).nativeClients;
      const client = clients.get(spawned.sessionId);
      if (!client) throw new Error("Spawned session has no native client");
      const originalClose = client.close.bind(client);
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered = false;
      vi.spyOn(client, "close").mockImplementation(async () => {
        entered = true;
        await barrier;
        await originalClose();
      });
      const first = service.closeSession(spawned.sessionId);
      let second: Promise<void> | undefined;
      try {
        await vi.waitFor(() => expect(entered).toBe(true));
        let secondFinished = false;
        second = (
          operation === "stop"
            ? service.stop()
            : service.closeSession(spawned.sessionId)
        ).then(() => {
          secondFinished = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(secondFinished).toBe(false);
        release();
        await Promise.all([first, second]);
      } finally {
        release();
        await Promise.allSettled([first, ...(second ? [second] : [])]);
      }
    },
    60000,
  );

  it("stop waits for initial-task terminal cleanup before releasing persistence", async () => {
    await service.start();
    const lifecycle = service as unknown as {
      closeInitialTaskSession(id: string): Promise<void>;
    };
    const originalClose = lifecycle.closeInitialTaskSession.bind(service);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let closeStarted = false;
    const closeSpy = vi
      .spyOn(lifecycle, "closeInitialTaskSession")
      .mockImplementation(async (id) => {
        closeStarted = true;
        await barrier;
        await originalClose(id);
      });
    let stopping: Promise<void> | undefined;
    try {
      await service.spawnSession({
        agentType: "elizaos",
        workdir,
        approvalPreset: "permissive",
        initialTask: "Return a completion response.",
      });
      await vi.waitFor(() => expect(closeStarted).toBe(true), {
        timeout: 15000,
      });
      let stopped = false;
      stopping = service.stop().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(stopped).toBe(false);
      release();
      await stopping;
      expect(closeSpy).toHaveResolvedTimes(1);
    } finally {
      release();
      await stopping;
    }
  }, 60000);

  it("spawn with an initialTask and NO explicit timeout sends the initial prompt with timeoutMs 0", async () => {
    // Pass-through spy: observes the real spawn→sendPrompt wiring without
    // altering behavior — the fake ACP subprocess still answers the prompt.
    const sendSpy = vi.spyOn(service, "sendPrompt");
    await service.start();
    const spawned = await service.spawnSession({
      agentType: "elizaos",
      workdir,
      approvalPreset: "permissive",
      initialTask: "Build a random-color web app",
    });
    try {
      await vi.waitFor(() => {
        expect(sendSpy).toHaveBeenCalled();
      });
      const [, , promptOpts] = sendSpy.mock.calls[0];
      expect(promptOpts?.timeoutMs).toBe(0);
    } finally {
      await service.closeSession(spawned.sessionId).catch(() => {});
    }
  }, 60_000);

  it("spawn with an explicit timeout forwards it to the initial prompt unchanged", async () => {
    const sendSpy = vi.spyOn(service, "sendPrompt");
    await service.start();
    const spawned = await service.spawnSession({
      agentType: "elizaos",
      workdir,
      approvalPreset: "permissive",
      initialTask: "Build a random-color web app",
      timeoutMs: 45_000,
    });
    try {
      await vi.waitFor(() => {
        expect(sendSpy).toHaveBeenCalled();
      });
      const [, , promptOpts] = sendSpy.mock.calls[0];
      expect(promptOpts?.timeoutMs).toBe(45_000);
    } finally {
      await service.closeSession(spawned.sessionId).catch(() => {});
    }
  }, 60_000);
});
