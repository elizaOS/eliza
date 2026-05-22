import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import type { IAgentRuntime, UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createHandler,
  ensureWorkspace,
  loadConfig,
} from "../../../cloud-services/coding-remote-runner/src/index.ts";
import { E2BRemoteCapabilityRouterService } from "./e2b-capability-router.ts";

const REMOTE_RUNNER_URL = "https://coding-remote-runner.test";
const REMOTE_RUNNER_TOKEN = "sat-token";

let workspaceRoot = "";
let originalFetch: typeof fetch;

function replaceGlobalFetch(fetchImpl: typeof fetch): void {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: fetchImpl,
  });
}

beforeEach(async () => {
  workspaceRoot = await mkdtemp(
    nodePath.join(tmpdir(), "agent-remote-runner-"),
  );
  originalFetch = globalThis.fetch;
});

afterEach(async () => {
  replaceGlobalFetch(originalFetch);
  await rm(workspaceRoot, { recursive: true, force: true });
});

function makeRuntime(): IAgentRuntime {
  const runtime: Partial<IAgentRuntime> = {
    agentId: "11111111-1111-1111-1111-111111111111" as UUID,
    character: { name: "Remote runner Proof" },
    getSetting: () => null,
    getService: () => null,
  };
  return runtime as IAgentRuntime;
}

async function installCodingRemoteRunnerFetch(): Promise<void> {
  const config = loadConfig({
    ELIZA_CODING_WORKSPACE: workspaceRoot,
    ELIZA_REMOTE_RUNNER_HTTP_TOKEN: REMOTE_RUNNER_TOKEN,
  });
  await ensureWorkspace(config);
  const handler = createHandler(config);
  const fetchMock: typeof fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin !== REMOTE_RUNNER_URL) {
        return originalFetch(input, init);
      }
      return handler(request);
    },
    { preconnect: originalFetch.preconnect },
  );
  replaceGlobalFetch(fetchMock);
}

describe("E2B remote runner router with the Coding remote runner HTTP runner", () => {
  it("runs coding commands through the remote runner workspace instead of the caller host", async () => {
    await installCodingRemoteRunnerFetch();
    const service = new E2BRemoteCapabilityRouterService(makeRuntime(), {
      enabled: true,
      provider: "home",
      remoteHttpBaseUrl: REMOTE_RUNNER_URL,
      remoteHttpToken: REMOTE_RUNNER_TOKEN,
      agentRunners: ["codex", "claude-code", "opencode"],
      workdir: "/workspace",
      hostWorkspaceRoot: workspaceRoot,
      timeoutMs: 30_000,
      requestTimeoutMs: 10_000,
      keepAlive: true,
      allowInternetAccess: false,
      envs: {},
      metadata: {},
    });

    const result = await service.pty.runCommand({
      command: "sh",
      args: ["-lc", "printf remote-coded > mobile-proof.txt"],
      cwd: "/workspace",
      timeoutMs: 10_000,
    });
    const read = await service.fs.readText({ path: "mobile-proof.txt" });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(read).toMatchObject({
      path: "/workspace/mobile-proof.txt",
      text: "remote-coded",
      truncated: false,
    });
    await expect(
      readFile(nodePath.join(workspaceRoot, "mobile-proof.txt"), "utf8"),
    ).resolves.toBe("remote-coded");
  });
});
