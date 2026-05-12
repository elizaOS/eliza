/**
 * Live e2e: SubAgentRouter wired to a real AcpService backed by the
 * installed `acpx` CLI. Verifies the full loop:
 *
 *   spawnSession → real acpx subprocess runs codex → emits task_complete
 *     → SubAgentRouter intercepts → posts synthetic Memory to runtime
 *     → fake messageService.handleMessage receives the memory
 *
 * Skipped unless:
 *   - `RUN_LIVE_ACPX=1` is set in env, AND
 *   - the `acpx` binary is on $PATH.
 *
 * Codex (or whatever AGENT is configured) must be authenticated. The test
 * runs in a throwaway tmp dir.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Memory } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AcpService } from "../../src/services/acp-service.js";
import { SubAgentRouter } from "../../src/services/sub-agent-router.js";

const ROOM = "11111111-2222-3333-4444-555555555555";
const USER = "ffffffff-1111-2222-3333-444444444444";
const PARENT_MSG = "99999999-8888-7777-6666-555555555555";

function isAcpxAvailable(): boolean {
  if (process.env.RUN_LIVE_ACPX !== "1") return false;
  const probe = spawnSync(process.env.ELIZA_ACP_CLI ?? "acpx", ["--version"], {
    encoding: "utf8",
  });
  return probe.status === 0;
}

const live = isAcpxAvailable();
const describeLive = live ? describe : describe.skip;

describeLive("SubAgentRouter (live, gated by RUN_LIVE_ACPX=1)", () => {
  let workdir: string;
  let acp: AcpService;
  let router: SubAgentRouter;
  let posts: Memory[] = [];

  function makeRuntime() {
    return {
      agentId: "00000000-0000-0000-0000-000000000001",
      logger: {
        debug: () => {},
        info: () => {},
        warn: (...args: unknown[]) => console.warn("[router]", ...args),
        error: (...args: unknown[]) => console.error("[router]", ...args),
      },
      getSetting: (key: string) => process.env[key],
      getService: (name: string) =>
        name === "ACP_SUBPROCESS_SERVICE" ? acp : null,
      createMemory: async () => undefined,
      emitEvent: async () => undefined,
      messageService: {
        handleMessage: async (
          _runtime: unknown,
          memory: Memory,
        ): Promise<unknown> => {
          posts.push(memory);
          return {};
        },
      },
    } as never;
  }

  beforeAll(async () => {
    workdir = mkdtempSync(join(tmpdir(), "acpx-live-"));
    const runtime = makeRuntime();
    acp = await AcpService.start(runtime);
    router = await SubAgentRouter.start(runtime);
  }, 30_000);

  afterAll(async () => {
    await router?.stop().catch(() => {});
    await acp?.stop().catch(() => {});
    if (workdir) rmSync(workdir, { recursive: true, force: true });
  });

  it("routes a real task_complete back as a synthetic memory", async () => {
    posts = [];
    const session = await acp.spawnSession({
      agentType: "codex",
      workdir,
      approvalPreset: "permissive",
      metadata: {
        roomId: ROOM,
        userId: USER,
        messageId: PARENT_MSG,
        label: "live-router-smoke",
        source: "test",
      },
    });

    const result = acp.sendPrompt
      ? await acp.sendPrompt(
          session.sessionId,
          "Reply with exactly: live-router-ok",
          { timeoutMs: 60_000 },
        )
      : await acp.sendToSession(
          session.sessionId,
          "Reply with exactly: live-router-ok",
        );

    expect(result.error).toBeFalsy();

    // Give the router callback a tick to drain.
    await new Promise((r) => setTimeout(r, 100));

    const subAgentPost = posts.find((m) => m.content?.source === "sub_agent");
    expect(subAgentPost).toBeTruthy();
    if (!subAgentPost) throw new Error("no sub_agent post received");
    expect(subAgentPost.roomId).toBe(ROOM);
    const md = subAgentPost.content?.metadata as Record<string, unknown>;
    expect(md?.subAgent).toBe(true);
    expect(md?.subAgentSessionId).toBe(session.sessionId);
    expect(md?.originUserId).toBe(USER);
    expect(typeof md?.subAgentRoundTrip).toBe("number");
  }, 120_000);
});
