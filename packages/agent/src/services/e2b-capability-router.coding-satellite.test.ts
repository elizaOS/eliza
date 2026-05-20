import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { type IAgentRuntime, type UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHandler,
  ensureWorkspace,
  loadConfig,
} from "../../../cloud-services/coding-satellite/src/index.ts";
import { E2BSatelliteCapabilityRouterService } from "./e2b-capability-router.ts";

const SATELLITE_URL = "https://coding-satellite.test";
const SATELLITE_TOKEN = "sat-token";

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
  workspaceRoot = await mkdtemp(nodePath.join(tmpdir(), "agent-satellite-"));
  originalFetch = globalThis.fetch;
});

afterEach(async () => {
  replaceGlobalFetch(originalFetch);
  await rm(workspaceRoot, { recursive: true, force: true });
});

function makeRuntime(): IAgentRuntime {
  const runtime: Partial<IAgentRuntime> = {
    agentId: "11111111-1111-1111-1111-111111111111" as UUID,
    character: { name: "Satellite Proof" },
    getSetting: () => null,
    getService: () => null,
  };
  return runtime as IAgentRuntime;
}

async function installCodingSatelliteFetch(): Promise<void> {
  const config = loadConfig({
    ELIZA_CODING_WORKSPACE: workspaceRoot,
    ELIZA_SATELLITE_HTTP_TOKEN: SATELLITE_TOKEN,
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
      if (url.origin !== SATELLITE_URL) {
        return originalFetch(input, init);
      }
      return handler(request);
    },
    { preconnect: originalFetch.preconnect },
  );
  replaceGlobalFetch(fetchMock);
}

describe("E2B Satellite router with the Coding Satellite HTTP runner", () => {
  it("runs coding commands through the Satellite workspace instead of the caller host", async () => {
    await installCodingSatelliteFetch();
    const service = new E2BSatelliteCapabilityRouterService(makeRuntime(), {
      enabled: true,
      provider: "home",
      satelliteHttpBaseUrl: SATELLITE_URL,
      satelliteHttpToken: SATELLITE_TOKEN,
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
      args: ["-lc", "printf satellite-coded > mobile-proof.txt"],
      cwd: "/workspace",
      timeoutMs: 10_000,
    });
    const read = await service.fs.readText({ path: "mobile-proof.txt" });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(read).toMatchObject({
      path: "/workspace/mobile-proof.txt",
      text: "satellite-coded",
      truncated: false,
    });
    await expect(
      readFile(nodePath.join(workspaceRoot, "mobile-proof.txt"), "utf8"),
    ).resolves.toBe("satellite-coded");
  });
});
