/**
 * The runtime registers the sandbox manager it started; the terminal and
 * sandbox routes must use it. Without it, local-safe terminal commands always
 * failed with "requires SandboxManager but none is available".
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readJsonBody, sendJson, sendJsonError } from "@elizaos/host";
import { afterEach, expect, it, vi } from "vitest";
import {
  handleMiscRoutes,
  type MiscRouteContext,
} from "../src/api/misc-routes.ts";
import { handleSandboxRouteGroup } from "../src/api/server-route-dispatch.ts";
import {
  getActiveSandboxManager,
  type SandboxManager,
  type SandboxRunOptions,
  setActiveSandboxManager,
} from "../src/services/sandbox-manager.ts";

const computeUse = vi.hoisted(() => ({
  handleSandboxRoute: vi.fn(async () => true),
}));
vi.mock("@elizaos/plugin-computeruse", () => computeUse);

function fakeManager() {
  const run = vi.fn(async (_options: SandboxRunOptions) => ({
    exitCode: 0,
    stdout: "from-sandbox\n",
    stderr: "",
    durationMs: 3,
    executedInSandbox: true,
  }));
  const manager = {
    engineType: "docker",
    run,
    getWorkspaceRoot: () => "/tmp",
  } as unknown as SandboxManager;
  return { manager, run };
}

let server: http.Server | null = null;

afterEach(async () => {
  setActiveSandboxManager(null);
  vi.unstubAllEnvs();
  computeUse.handleSandboxRoute.mockClear();
  if (server)
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
});

async function runTerminal(command: string) {
  let active = 0;
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void handleMiscRoutes({
      req,
      res,
      method: req.method ?? "GET",
      pathname: url.pathname,
      url,
      state: { shellEnabled: true } as unknown as MiscRouteContext["state"],
      json: sendJson,
      error: sendJsonError,
      readJsonBody,
      resolveTerminalRunRejection: () => null,
      resolveTerminalRunClientId: () => "terminal-test",
      isSharedTerminalClientId: () => false,
      get activeTerminalRunCount() {
        return active;
      },
      setActiveTerminalRunCount: (delta: number) => {
        active += delta;
      },
      resolveTerminalShellCommand: () => ({
        command: "/bin/sh",
        argsFor: (line: string) => ["-c", line],
      }),
    } as unknown as MiscRouteContext);
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/api/terminal/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command, captureOutput: true }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

it("runs a local-safe terminal command through the registered sandbox manager", async () => {
  vi.stubEnv("ELIZA_RUNTIME_MODE", "local-safe");
  const { manager, run } = fakeManager();
  setActiveSandboxManager(manager);

  const result = await runTerminal("echo hi");

  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({
    exitCode: 0,
    stdout: "from-sandbox\n",
    sandbox: "docker",
  });
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0]?.[0]).toMatchObject({
    cmd: "/bin/sh",
    args: ["-c", "echo hi"],
  });
});

it("still refuses a local-safe terminal command when no manager is registered", async () => {
  vi.stubEnv("ELIZA_RUNTIME_MODE", "local-safe");
  expect(getActiveSandboxManager()).toBeNull();

  const result = await runTerminal("echo hi");

  expect(result.status).not.toBe(200);
});

it("hands the registered manager to the sandbox routes when server state has none", async () => {
  const { manager } = fakeManager();
  setActiveSandboxManager(manager);

  const handled = await handleSandboxRouteGroup({
    req: {} as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method: "GET",
    pathname: "/api/sandbox/status",
    state: { sandboxManager: null } as never,
  });

  expect(handled).toBe(true);
  expect(computeUse.handleSandboxRoute).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    "/api/sandbox/status",
    "GET",
    { sandboxManager: manager },
  );
});
